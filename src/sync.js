'use strict';

// LAN peer-to-peer sync over mDNS discovery + WebSockets.
// No cloud, no accounts. Each instance advertises itself on the local
// network, discovers peers, and keeps a single WebSocket per peer for
// full-duplex note syncing.

const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'sendit';
// Bump if the wire format ever changes in a breaking way.
const PROTOCOL = 1;

class Sync extends EventEmitter {
  constructor({ id, name }) {
    super();
    this.id = id;
    this.name = name || os.hostname();
    this.peers = new Map(); // peerId -> { ws, name }
    this.pending = new Map(); // peerId -> reconnect info
    this.history = [];
    this.bonjour = null;
    this.wss = null;
    this.browser = null;
    this.service = null;
    this._stopped = false;
  }

  setHistory(history) {
    this.history = Array.isArray(history) ? history : [];
  }

  start() {
    // 1) Stand up a WebSocket server on an ephemeral port.
    this.wss = new WebSocketServer({ port: 0, host: '0.0.0.0' });

    this.wss.on('listening', () => {
      const port = this.wss.address().port;
      this._advertise(port);
      this._browse();
      this.emit('status', this.statusSnapshot());
    });

    this.wss.on('connection', (ws) => {
      this._wireConnection(ws, /*outbound*/ false);
    });

    this.wss.on('error', (err) => {
      this.emit('log', 'server error: ' + err.message);
    });
  }

  _advertise(port) {
    this.bonjour = new Bonjour();
    this.service = this.bonjour.publish({
      name: 'SendIt-' + this.id.slice(0, 8),
      type: SERVICE_TYPE,
      port,
      txt: { id: this.id, name: this.name, proto: String(PROTOCOL) },
    });
  }

  _browse() {
    this.browser = this.bonjour.find({ type: SERVICE_TYPE });

    this.browser.on('up', (svc) => this._onServiceUp(svc));
    this.browser.on('down', () => {
      this.emit('status', this.statusSnapshot());
    });

    // Periodically re-scan so we recover from sleeping/reconnecting peers.
    this._scanTimer = setInterval(() => {
      try { this.browser.update(); } catch (_) {}
    }, 5000);
  }

  _onServiceUp(svc) {
    const txt = svc.txt || {};
    const peerId = txt.id;
    if (!peerId || peerId === this.id) return; // ignore self
    if (this.peers.has(peerId)) return; // already connected

    // Deterministic single connection: only the lower id dials out.
    // The higher id simply waits to accept the inbound connection.
    if (this.id >= peerId) return;

    const host = (svc.addresses || []).find((a) => a.includes('.')) || svc.host;
    if (!host) return;
    this._dial(peerId, host, svc.port, txt.name);
  }

  _dial(peerId, host, port, name) {
    if (this.peers.has(peerId)) return;
    const url = `ws://${host}:${port}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return;
    }
    ws._peerName = name;
    ws.on('error', () => {});
    this._wireConnection(ws, /*outbound*/ true, peerId);
  }

  _wireConnection(ws, outbound, knownPeerId) {
    let peerId = knownPeerId || null;

    const sendHello = () => {
      this._send(ws, {
        kind: 'hello',
        proto: PROTOCOL,
        id: this.id,
        name: this.name,
      });
    };

    if (outbound) {
      ws.on('open', sendHello);
    } else {
      sendHello();
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      if (msg.kind === 'hello') {
        peerId = msg.id;
        if (peerId === this.id) {
          ws.close();
          return;
        }
        // If we somehow already have this peer, keep the existing one.
        if (this.peers.has(peerId)) {
          ws.close();
          return;
        }
        this.peers.set(peerId, { ws, name: msg.name });
        // Send our full history so the peer is caught up immediately.
        this._send(ws, { kind: 'history', notes: this.history });
        this.emit('status', this.statusSnapshot());
        this.emit('log', `connected to ${msg.name}`);
        return;
      }

      if (msg.kind === 'history' && Array.isArray(msg.notes)) {
        let added = false;
        for (const note of msg.notes) {
          if (this._absorb(note)) added = true;
        }
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
        if (this.history.length !== before) {
          this.emit('history-changed', this.history);
        }
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

  // Add a locally-created note and broadcast it to peers.
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
    for (const { ws } of this.peers.values()) {
      this._send(ws, msg);
    }
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
    this._stopped = true;
    clearInterval(this._scanTimer);
    try { this.browser && this.browser.stop(); } catch (_) {}
    try {
      if (this.bonjour) {
        this.bonjour.unpublishAll(() => {
          try { this.bonjour.destroy(); } catch (_) {}
        });
      }
    } catch (_) {}
    try { this.wss && this.wss.close(); } catch (_) {}
    for (const { ws } of this.peers.values()) {
      try { ws.close(); } catch (_) {}
    }
    this.peers.clear();
  }
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { Sync, newId, SERVICE_TYPE };
