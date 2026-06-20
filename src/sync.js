'use strict';

// LAN peer-to-peer sync. No cloud, no accounts.
//
// Discovery is a tiny UDP *broadcast* beacon on a dedicated port. We
// deliberately do NOT use mDNS/Bonjour: on macOS (mDNSResponder) and Linux
// (avahi) the OS already owns port 5353 and swallows inbound multicast from
// the network, so a userland mDNS stack only ever hears services on its own
// machine. A plain UDP broadcast on our own port has no such competitor and
// behaves identically on both platforms.
//
// Each instance also accepts a manually-entered peer IP as a fallback for
// networks that filter broadcast traffic.
//
// Sync itself is a single WebSocket per peer on a fixed port.

const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');
const { WebSocketServer, WebSocket } = require('ws');

// Fixed ports so manual "connect by IP" works without knowing a random port.
const WS_PORT = 50778;
const DISCOVERY_PORT = 50777;
const BEACON_INTERVAL = 2000;
// Bump if the wire format ever changes in a breaking way.
const PROTOCOL = 2;

class Sync extends EventEmitter {
  constructor({ id, name, wsPort, discoveryPort, manualPeers }) {
    super();
    this.id = id;
    this.name = name || os.hostname();
    this.wsPort = wsPort || WS_PORT;
    this.discoveryPort = discoveryPort || DISCOVERY_PORT;
    this.manualPeers = Array.isArray(manualPeers) ? manualPeers : [];

    this.peers = new Map(); // peerId -> { ws, name }
    this.dialing = new Set(); // peerId or addr keys currently being dialed
    this.history = [];

    this.wss = null;
    this.disco = null;
    this._beaconTimer = null;
  }

  setHistory(history) {
    this.history = Array.isArray(history) ? history : [];
  }

  setManualPeers(list) {
    this.manualPeers = Array.isArray(list) ? list : [];
  }

  start() {
    // WebSocket server on a fixed port.
    this.wss = new WebSocketServer({ port: this.wsPort, host: '0.0.0.0' });
    this.wss.on('connection', (ws) => this._wireConnection(ws, /*outbound*/ false));
    this.wss.on('error', (err) => this.emit('log', 'server error: ' + err.message));
    this.wss.on('listening', () => {
      this._startDiscovery();
      this.emit('status', this.statusSnapshot());
    });
  }

  // ---- Discovery (UDP broadcast) ----

  _startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.disco = sock;
    sock.on('error', (e) => this.emit('log', 'discovery error: ' + e.message));
    sock.on('message', (buf, rinfo) => this._onBeacon(buf, rinfo));
    sock.bind(this.discoveryPort, () => {
      try { sock.setBroadcast(true); } catch (_) {}
      this._beacon();
      this._beaconTimer = setInterval(() => this._beacon(), BEACON_INTERVAL);
    });
  }

  _broadcastAddrs() {
    const addrs = new Set(['255.255.255.255']);
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal && ni.address && ni.netmask) {
          addrs.add(directedBroadcast(ni.address, ni.netmask));
        }
      }
    }
    return [...addrs];
  }

  _beacon() {
    if (!this.disco) return;
    const msg = Buffer.from(JSON.stringify({
      t: 'sendit',
      id: this.id,
      name: this.name,
      port: this.wsPort,
      proto: PROTOCOL,
    }));
    for (const addr of this._broadcastAddrs()) {
      try { this.disco.send(msg, this.discoveryPort, addr); } catch (_) {}
    }
    // Also poke any manually-configured peers (broadcast may be filtered).
    for (const ip of this.manualPeers) {
      if (ip) this._dial('ip:' + ip, ip, this.wsPort, ip);
    }
  }

  _onBeacon(buf, rinfo) {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (!m || m.t !== 'sendit' || !m.id || m.id === this.id) return;
    if (this.peers.has(m.id)) return;
    // Deterministic single connection: only the lower id dials out.
    if (this.id >= m.id) return;
    this._dial(m.id, rinfo.address, m.port || this.wsPort, m.name);
  }

  _dial(dialKey, host, port, name) {
    // dialKey is the peer id (from beacon) or "ip:x.x.x.x" (manual).
    if (this.dialing.has(dialKey)) return;
    // If we already hold a connection to this peer id, skip.
    if (this.peers.has(dialKey)) return;
    this.dialing.add(dialKey);

    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${port}`);
    } catch (_) {
      this.dialing.delete(dialKey);
      return;
    }
    ws._peerName = name;
    const clear = () => this.dialing.delete(dialKey);
    ws.on('close', clear);
    ws.on('error', () => clear());
    this._wireConnection(ws, /*outbound*/ true);
  }

  // ---- Connection wiring (shared by inbound + outbound) ----

  _wireConnection(ws, outbound) {
    let peerId = null;

    const sendHello = () => {
      this._send(ws, { kind: 'hello', proto: PROTOCOL, id: this.id, name: this.name });
    };
    if (outbound) ws.on('open', sendHello);
    else sendHello();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      if (msg.kind === 'hello') {
        peerId = msg.id;
        if (peerId === this.id) { ws.close(); return; }
        if (this.peers.has(peerId)) { ws.close(); return; } // dedupe
        this.peers.set(peerId, { ws, name: msg.name });
        this.dialing.delete(peerId);
        this._send(ws, { kind: 'history', notes: this.history });
        this.emit('status', this.statusSnapshot());
        this.emit('log', `connected to ${msg.name}`);
        return;
      }

      if (msg.kind === 'history' && Array.isArray(msg.notes)) {
        let added = false;
        for (const note of msg.notes) if (this._absorb(note)) added = true;
        if (added) this.emit('history-changed', this.history);
        return;
      }

      if (msg.kind === 'note' && msg.note) {
        if (this._absorb(msg.note)) {
          this.emit('history-changed', this.history);
          this.emit('incoming', msg.note);
        }
        return;
      }

      if (msg.kind === 'delete' && msg.id) {
        const before = this.history.length;
        this.history = this.history.filter((n) => n.id !== msg.id);
        if (this.history.length !== before) this.emit('history-changed', this.history);
        return;
      }

      if (msg.kind === 'clear') {
        this.history = [];
        this.emit('history-changed', this.history);
        return;
      }
    });

    const cleanup = () => {
      if (peerId && this.peers.get(peerId) && this.peers.get(peerId).ws === ws) {
        this.peers.delete(peerId);
        this.emit('status', this.statusSnapshot());
        this.emit('log', 'peer disconnected');
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  // Merge a note into history (dedupe by id). Returns true if new.
  _absorb(note) {
    if (!note || !note.id) return false;
    if (this.history.some((n) => n.id === note.id)) return false;
    this.history.unshift(note);
    this._trim();
    return true;
  }

  _trim() {
    const MAX = 300;
    if (this.history.length > MAX) this.history.length = MAX;
  }

  publishNote(note) {
    this._absorb(note);
    this._broadcast({ kind: 'note', note });
    this.emit('history-changed', this.history);
  }

  deleteNote(id) {
    this.history = this.history.filter((n) => n.id !== id);
    this._broadcast({ kind: 'delete', id });
    this.emit('history-changed', this.history);
  }

  clearAll() {
    this.history = [];
    this._broadcast({ kind: 'clear' });
    this.emit('history-changed', this.history);
  }

  _broadcast(msg) {
    for (const { ws } of this.peers.values()) this._send(ws, msg);
  }

  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  statusSnapshot() {
    return {
      connected: this.peers.size > 0,
      count: this.peers.size,
      peers: [...this.peers.values()].map((p) => p.name),
      selfName: this.name,
    };
  }

  stop() {
    clearInterval(this._beaconTimer);
    try { this.disco && this.disco.close(); } catch (_) {}
    try { this.wss && this.wss.close(); } catch (_) {}
    for (const { ws } of this.peers.values()) {
      try { ws.close(); } catch (_) {}
    }
    this.peers.clear();
  }
}

// Compute the directed broadcast address for an interface, e.g.
// 192.168.68.60 / 255.255.255.0 -> 192.168.68.255
function directedBroadcast(ip, mask) {
  const ipp = ip.split('.').map(Number);
  const mp = mask.split('.').map(Number);
  return ipp.map((o, i) => (o & mp[i]) | (~mp[i] & 0xff)).join('.');
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { Sync, newId, WS_PORT, DISCOVERY_PORT };
