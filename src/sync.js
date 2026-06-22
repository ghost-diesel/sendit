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
    this.peerHosts = new Map(); // peerId -> remote host (to suppress redundant manual dials)
    this.dialing = new Set(); // peerId or addr keys currently being dialed
    this.history = [];
    this.peerActions = new Map(); // peerId -> { enabled, list }
    this.peerTerminal = new Map(); // peerId -> enabled (does the peer expose a shell?)
    this.actionsProvider = null; // set by main: { publicState, run, pairingToken, peerToken }
    this.terminalProvider = null; // set by main: { enabled, pairingToken, open, write, resize, close, has, closePeer }

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

  // Provider bridges to the local Actions registry without coupling Sync to it.
  setActionsProvider(p) {
    this.actionsProvider = p;
  }

  // Provider bridges to the local PTY manager (Remote Terminal) the same way.
  setTerminalProvider(p) {
    this.terminalProvider = p;
  }

  start() {
    // WebSocket server on a fixed port.
    this.wss = new WebSocketServer({ port: this.wsPort, host: '0.0.0.0' });
    this.wss.on('connection', (ws, req) => {
      const ip = normalizeIp((req && req.socket && req.socket.remoteAddress) || (ws._socket && ws._socket.remoteAddress));
      this._wireConnection(ws, /*outbound*/ false, ip);
    });
    this.wss.on('error', (err) => this.emit('log', 'server error: ' + err.message));
    this.wss.on('listening', () => {
      this._startDiscovery();
      this._startHeartbeat();
      this.emit('status', this.statusSnapshot());
    });
  }

  // Ping every peer periodically; if one missed the previous ping (no pong),
  // it's a dead half-open socket — terminate it so cleanup runs and the next
  // beacon re-dials. This is what recovers from a peer reboot / network drop.
  _startHeartbeat() {
    this._hbTimer = setInterval(() => {
      for (const { ws } of this.peers.values()) {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch (_) {}
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
      }
    }, 15000);
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
    // Accepts "ip" or "ip:port" (defaults to our WS port). Skip any host we're
    // already connected to — otherwise we'd re-dial every beacon and churn the
    // live connection (replace-on-hello would keep swapping it out).
    const connectedHosts = new Set([...this.peerHosts.values()]);
    for (const entry of this.manualPeers) {
      if (!entry) continue;
      let ip = String(entry).trim();
      let port = this.wsPort;
      const idx = ip.lastIndexOf(':');
      if (idx > 0 && /^\d+$/.test(ip.slice(idx + 1))) { port = Number(ip.slice(idx + 1)); ip = ip.slice(0, idx); }
      if (connectedHosts.has(ip)) continue;
      this._dial('ip:' + entry, ip, port, ip);
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
    const where = `${host}:${port}`;
    this.emit('log', `→ connecting to ${where}${dialKey.startsWith('ip:') ? ' (manual)' : ''}`);
    // Don't let a stuck TCP connect (peer mid-reboot, SYN dropped) hold the
    // dial open — ws's default connect timeout is ~75s, which would block
    // retries. Cap it at 5s so the next beacon can try again.
    const connectTimer = setTimeout(() => {
      this.emit('log', `✕ connect to ${where} timed out (no response in 5s)`);
      try { ws.terminate(); } catch (_) {}
    }, 5000);
    const clear = () => { clearTimeout(connectTimer); this.dialing.delete(dialKey); };
    ws.on('open', () => { clearTimeout(connectTimer); this.emit('log', `✓ socket open to ${where} — sent hello`); });
    ws.on('close', clear);
    ws.on('error', (e) => {
      const code = (e && (e.code || e.message)) || 'error';
      let extra = '';
      if ((code === 'EHOSTUNREACH' || code === 'ENETUNREACH') && process.platform === 'darwin') {
        extra = ' — macOS is blocking Local Network access for this app. Enable it: System Settings → Privacy & Security → Local Network → Send It.';
      }
      this.emit('log', `✕ connect to ${where} failed: ${code}${extra}`);
      clear();
    });
    this._wireConnection(ws, /*outbound*/ true, host);
  }

  // ---- Connection wiring (shared by inbound + outbound) ----

  _wireConnection(ws, outbound, remoteHost) {
    let peerId = null;
    let helloDone = false;

    // Heartbeat liveness: a pong marks the socket alive (see _startHeartbeat).
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // If the hello handshake never completes (peer half-open, version/proto
    // weirdness, or a socket that opens but never replies), tear it down so the
    // dial slot frees and the next beacon retries — instead of wedging forever
    // on a TCP-alive but never-handshaked socket. THIS is the fix for "TCP
    // reachable but stuck on Searching".
    const helloTimer = setTimeout(() => {
      if (!helloDone) {
        this.emit('log', '✕ handshake timed out (no hello) — closing, will retry');
        try { ws.terminate(); } catch (_) {}
      }
    }, 8000);

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
        if (peerId === this.id) { this.emit('log', 'ignored self-connection'); clearTimeout(helloTimer); ws.close(); return; }
        helloDone = true;
        clearTimeout(helloTimer);
        this.emit('log', `← hello from ${msg.name} (${String(peerId).slice(0, 8)})`);
        // A fresh hello from a peer we already "have" means the old link is
        // stale — the peer restarted or the network dropped without a clean
        // close. Replace it instead of rejecting, so a reconnect always wins.
        const existing = this.peers.get(peerId);
        if (existing && existing.ws !== ws) {
          this.emit('log', `replacing stale link to ${msg.name}`);
          try { existing.ws.terminate(); } catch (_) {}
        }
        ws.isAlive = true;
        this.peers.set(peerId, { ws, name: msg.name });
        if (remoteHost) this.peerHosts.set(peerId, remoteHost);
        this.dialing.delete(peerId);
        // Surface "connected" FIRST — nothing below may hide it, and a controller
        // connects regardless of whether IT has Trusted Actions enabled.
        this.emit('status', this.statusSnapshot());
        this.emit('log', `✓ connected to ${msg.name}`);
        // History + action-list are best-effort; they must never abort the
        // handshake (an error here used to leave the peer "Searching").
        try { this._send(ws, { kind: 'history', notes: this.history }); }
        catch (e) { this.emit('log', 'history send error: ' + (e && e.message)); }
        try { this._sendActions(ws); }
        catch (e) { this.emit('log', 'actions send error: ' + (e && e.message)); }
        try { this._sendTermState(ws); }
        catch (e) { this.emit('log', 'term-state send error: ' + (e && e.message)); }
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

      // ---- Trusted Actions (ids only cross the wire) ----

      if (msg.kind === 'actions') {
        // Peer told us which actions it exposes (id/label/flags, no commands).
        this.peerActions.set(peerId, {
          enabled: !!msg.enabled,
          list: Array.isArray(msg.list) ? msg.list : [],
        });
        const name = (this.peers.get(peerId) || {}).name;
        this.emit('peer-actions', { peerId, name, ...this.peerActions.get(peerId) });
        return;
      }

      if (msg.kind === 'run') {
        this._handleRun(ws, peerId, msg);
        return;
      }

      if (msg.kind === 'run-result') {
        this.emit('run-result', {
          peerId, reqId: msg.reqId, id: msg.id,
          ok: !!msg.ok, code: msg.code, output: msg.output, error: msg.error,
        });
        return;
      }

      // ---- Remote Terminal (PTY stream; pairing-code gated like Trusted Actions) ----

      // Peer told us whether it exposes a shell (drives the terminal button).
      if (msg.kind === 'term-state') {
        this.peerTerminal.set(peerId, !!msg.enabled);
        const name = (this.peers.get(peerId) || {}).name;
        this.emit('peer-terminal', { peerId, name, enabled: !!msg.enabled });
        return;
      }

      // A peer asked us to open a shell. Validate + spawn on THIS machine.
      if (msg.kind === 'term-open') {
        this._handleTermOpen(ws, peerId, msg);
        return;
      }

      // Executor's ack for our open request — surface it to the renderer.
      if (msg.kind === 'term-opened') {
        this.emit('term-opened', {
          peerId, reqId: msg.reqId, sid: msg.sid, ok: !!msg.ok, error: msg.error,
        });
        return;
      }

      // term-data is bidirectional on one kind. If WE own the session id it's
      // keystrokes for our local PTY (executor role); otherwise it's shell
      // output bound for our renderer (client role). sids are UUIDs, so the
      // ownership test is unambiguous even if both ends run terminals.
      if (msg.kind === 'term-data' && msg.sid) {
        if (this.terminalProvider && this.terminalProvider.has(msg.sid)) {
          this.terminalProvider.write(msg.sid, msg.data);
        } else {
          this.emit('term-data', { peerId, sid: msg.sid, data: msg.data });
        }
        return;
      }

      if (msg.kind === 'term-resize' && msg.sid) {
        if (this.terminalProvider) this.terminalProvider.resize(msg.sid, msg.cols, msg.rows);
        return;
      }

      // Client closed the pane → kill our PTY. (Executor→client teardown uses
      // term-exit, below.)
      if (msg.kind === 'term-close' && msg.sid) {
        if (this.terminalProvider && this.terminalProvider.has(msg.sid)) {
          this.terminalProvider.close(msg.sid);
        }
        return;
      }

      // Shell exited on the executor — tell the renderer to close the tab.
      if (msg.kind === 'term-exit' && msg.sid) {
        this.emit('term-exit', { peerId, sid: msg.sid, code: msg.code });
        return;
      }
    });

    const cleanup = () => {
      clearTimeout(helloTimer);
      if (peerId && this.peers.get(peerId) && this.peers.get(peerId).ws === ws) {
        const name = this.peers.get(peerId).name;
        this.peers.delete(peerId);
        this.peerHosts.delete(peerId);
        this.peerActions.delete(peerId);
        this.peerTerminal.delete(peerId);
        // Never leave an orphan shell running for a link that's gone.
        if (this.terminalProvider) { try { this.terminalProvider.closePeer(peerId); } catch (_) {} }
        this.emit('peer-actions', { peerId, enabled: false, list: [] });
        this.emit('peer-terminal', { peerId, enabled: false });
        this.emit('status', this.statusSnapshot());
        this.emit('log', `✕ disconnected from ${name || String(peerId).slice(0, 8)}`);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  // Drop all peers and immediately re-dial (the "Force reconnect" button).
  reconnect() {
    this.emit('log', 'forcing reconnect…');
    for (const { ws } of this.peers.values()) { try { ws.terminate(); } catch (_) {} }
    this.peers.clear();
    this.peerHosts.clear();
    this.peerActions.clear();
    this.peerTerminal.clear();
    this.dialing.clear();
    this.emit('status', this.statusSnapshot());
    this._beacon();
  }

  // ---- Trusted Actions plumbing ----

  _sendActions(ws) {
    if (!this.actionsProvider) return;
    let st;
    try { st = this.actionsProvider.publicState(); } catch (_) { st = { enabled: false, list: [] }; }
    this._send(ws, { kind: 'actions', enabled: !!st.enabled, list: st.list || [] });
  }

  // Re-advertise our action list to all peers (after a toggle/edit/reload).
  broadcastActions() {
    for (const { ws } of this.peers.values()) this._sendActions(ws);
  }

  // Tell a peer whether we expose a shell (enabled AND the native PTY loaded).
  _sendTermState(ws) {
    if (!this.terminalProvider) return;
    let on = false;
    try { on = !!this.terminalProvider.enabled(); } catch (_) {}
    this._send(ws, { kind: 'term-state', enabled: on });
  }

  // Re-advertise our terminal availability to all peers (after a toggle).
  broadcastTerminalState() {
    for (const { ws } of this.peers.values()) this._sendTermState(ws);
  }

  // A peer asked us to run an action. Validate the pairing token + allow-list,
  // execute locally, and return the result. Only the id crossed the wire.
  _handleRun(ws, peerId, msg) {
    const reply = (r) => this._send(ws, {
      kind: 'run-result', reqId: msg.reqId, id: msg.id,
      ok: !!r.ok, code: r.code === undefined ? null : r.code, output: r.output, error: r.error,
    });
    const provider = this.actionsProvider;
    if (!provider) return reply({ ok: false, error: 'actions not available on target' });

    const expected = provider.pairingToken();
    if (!expected || msg.token !== expected) {
      return reply({ ok: false, error: 'not paired — invalid or missing pairing code' });
    }
    const name = (this.peers.get(peerId) || {}).name || 'peer';
    provider.run(msg.id, { id: peerId, name }, reply);
  }

  // Ask a peer to run one of its actions. Returns a request id (or null).
  // The result arrives later via the 'run-result' event.
  sendRun(peerId, actionId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const reqId = crypto.randomUUID();
    const token = this.actionsProvider ? this.actionsProvider.peerToken(peerId) : '';
    this._send(peer.ws, { kind: 'run', reqId, id: actionId, token: token || '' });
    return reqId;
  }

  // ---- Remote Terminal plumbing (executor + client) ----

  // A peer asked us to open a shell. Validate the pairing token + that the
  // feature is enabled HERE, spawn a local PTY, and stream it back over this
  // socket. Modeled on _handleRun — only an open request crossed the wire.
  _handleTermOpen(ws, peerId, msg) {
    const reply = (r) => this._send(ws, {
      kind: 'term-opened', reqId: msg.reqId,
      sid: r.ok ? r.sid : null, ok: !!r.ok, error: r.error,
    });
    const provider = this.terminalProvider;
    if (!provider) return reply({ ok: false, error: 'terminal not available on target' });
    if (!provider.enabled()) return reply({ ok: false, error: 'remote terminal is disabled on this machine' });

    const expected = provider.pairingToken();
    if (!expected || msg.token !== expected) {
      return reply({ ok: false, error: 'not paired — invalid or missing pairing code' });
    }

    const result = provider.open({
      peerId,
      cols: msg.cols, rows: msg.rows,
      onData: (sid, data) => this._send(ws, { kind: 'term-data', sid, data }),
      onExit: (sid, code) => this._send(ws, { kind: 'term-exit', sid, code }),
    });
    reply(result);
  }

  // Client side: ask a peer to open a shell. Signs with the peer's pairing
  // code (same token store as Trusted Actions). Returns a reqId, or null.
  // The 'term-opened' event carries the session id assigned by the executor.
  sendTermOpen(peerId, cols, rows) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const reqId = crypto.randomUUID();
    const token = this.actionsProvider ? this.actionsProvider.peerToken(peerId) : '';
    this._send(peer.ws, { kind: 'term-open', reqId, cols, rows, token: token || '' });
    return reqId;
  }

  sendTermData(peerId, sid, data) {
    const peer = this.peers.get(peerId);
    if (peer) this._send(peer.ws, { kind: 'term-data', sid, data });
  }

  sendTermResize(peerId, sid, cols, rows) {
    const peer = this.peers.get(peerId);
    if (peer) this._send(peer.ws, { kind: 'term-resize', sid, cols, rows });
  }

  sendTermClose(peerId, sid) {
    const peer = this.peers.get(peerId);
    if (peer) this._send(peer.ws, { kind: 'term-close', sid });
  }

  // Merge a note into history (dedupe by id). Returns true if new.
  _absorb(note) {
    if (!note || !note.id) return false;
    if (this.history.some((n) => n.id === note.id)) return false;
    // localPath is a machine-local field (where WE saved a received file).
    // Never trust one that arrived over the wire from a peer.
    if (note.localPath) delete note.localPath;
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

  // Low-level health snapshot for the diagnostics panel.
  diagnostics() {
    return {
      wsPort: this.wsPort,
      discoveryPort: this.discoveryPort,
      listening: !!(this.wss && this.wss.address()),
      discoveryBound: !!this.disco,
      connected: this.peers.size > 0,
      peers: [...this.peers.values()].map((p) => p.name),
      manualPeers: [...this.manualPeers],
    };
  }

  // Current known action lists from connected peers (for renderer init).
  peerActionsSnapshot() {
    const out = [];
    for (const [peerId, pa] of this.peerActions) {
      const name = (this.peers.get(peerId) || {}).name;
      out.push({ peerId, name, enabled: pa.enabled, list: pa.list });
    }
    return out;
  }

  // Which connected peers currently expose a shell (for renderer init).
  peerTerminalSnapshot() {
    const out = [];
    for (const [peerId, enabled] of this.peerTerminal) {
      const name = (this.peers.get(peerId) || {}).name;
      out.push({ peerId, name, enabled });
    }
    return out;
  }

  stop() {
    clearInterval(this._beaconTimer);
    clearInterval(this._hbTimer);
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
// IPv4-mapped IPv6 (::ffff:192.168.0.5) -> 192.168.0.5 so it matches manual entries.
function normalizeIp(ip) {
  return ip ? String(ip).replace(/^::ffff:/, '') : ip;
}

function directedBroadcast(ip, mask) {
  const ipp = ip.split('.').map(Number);
  const mp = mask.split('.').map(Number);
  return ipp.map((o, i) => (o & mp[i]) | (~mp[i] & 0xff)).join('.');
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { Sync, newId, WS_PORT, DISCOVERY_PORT };
