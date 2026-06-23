'use strict';

// Executor-side PTY manager for the embedded Remote Terminal feature.
//
// SAFETY MODEL (see docs/TERMINAL.md) — mirrors Trusted Actions:
//  - A real PTY shell is spawned ONLY on the machine the user explicitly
//    enabled it on (`terminalEnabled` in config, OFF by default). This is a
//    SEPARATE switch from Trusted Actions.
//  - Every open/list/attach is gated by the same pairing code as Trusted
//    Actions (validated in sync.js). Unpaired peers get nothing.
//  - The shell runs as the current user with no privilege escalation.
//  - node-pty is a NATIVE module, required lazily inside a try/catch so a
//    missing/ABI-mismatched build cleanly DISABLES the feature instead of
//    crashing the app.
//
// PERSISTENCE: sessions are tmux-style. A PTY keeps running on this machine
// when the client closes the panel or the link drops — we DETACH (keep alive,
// keep buffering output) rather than kill. The client reattaches later via
// list()/attach() and we replay a recent-output buffer to repaint the screen.
// A session is only killed by an explicit close(), the idle reaper, or app
// shutdown. This is what lets "start an upgrade, walk away, come back" work.

const os = require('os');
const crypto = require('crypto');

// Lazy, fail-soft native load. `pty` stays null if node-pty isn't built for
// this runtime (e.g. running unpackaged electron without `npm run rebuild`).
let pty = null;
let loadError = null;
function loadPty() {
  if (pty || loadError) return pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    loadError = e;
  }
  return pty;
}

const MAX_SESSIONS_PER_PEER = 8;          // guard against a runaway client
const BUFFER_LIMIT = 256 * 1024;          // per-session replay ring buffer (bytes)
const IDLE_REAP_MS = 4 * 60 * 60 * 1000;  // kill detached + silent sessions after 4h
const REAP_INTERVAL_MS = 5 * 60 * 1000;

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sid -> session
    this._seq = 0;
    // Periodically reap shells that were detached and have been silent a long
    // time, so abandoned sessions don't accumulate forever. unref so the timer
    // never keeps the process alive on its own.
    this._reaper = setInterval(() => this._reap(), REAP_INTERVAL_MS);
    if (this._reaper.unref) this._reaper.unref();
  }

  available() {
    return !!loadPty();
  }

  unavailableReason() {
    if (this.available()) return null;
    return loadError
      ? 'node-pty failed to load on this build: ' + (loadError.message || loadError)
      : 'node-pty is not installed on this machine';
  }

  // Append shell output to the session's replay buffer (trim from the front).
  _append(session, data) {
    session.buf += data;
    if (session.buf.length > BUFFER_LIMIT) {
      session.buf = session.buf.slice(session.buf.length - BUFFER_LIMIT);
    }
    session.lastActivity = Date.now();
  }

  // Spawn a NEW PTY, attached to the requesting client. `onData(sid, data)`
  // streams output; `onExit(sid, code)` fires once. Returns { ok, sid, seq }.
  open({ peerId, cols, rows, onData, onExit }) {
    const lib = loadPty();
    if (!lib) return { ok: false, error: this.unavailableReason() };

    let count = 0;
    for (const s of this.sessions.values()) if (s.peerId === peerId) count++;
    if (count >= MAX_SESSIONS_PER_PEER) {
      return { ok: false, error: `too many terminal sessions (max ${MAX_SESSIONS_PER_PEER})` };
    }

    const sid = crypto.randomUUID();
    const cw = clampDim(cols, 80);
    const rw = clampDim(rows, 24);
    let child;
    try {
      child = lib.spawn(defaultShell(), [], {
        name: 'xterm-256color', cols: cw, rows: rw,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', SENDIT_TERMINAL: '1' },
      });
    } catch (e) {
      return { ok: false, error: 'failed to start shell: ' + e.message };
    }

    const session = {
      sid, pty: child, peerId, seq: ++this._seq, cols: cw, rows: rw,
      buf: '', attached: true, sink: onData || null, onExit: onExit || null,
      lastActivity: Date.now(),
    };
    this.sessions.set(sid, session);

    child.onData((data) => {
      this._append(session, data);
      if (session.attached && session.sink) { try { session.sink(sid, data); } catch (_) {} }
    });
    child.onExit(({ exitCode }) => {
      this.sessions.delete(sid);
      if (session.attached && session.onExit) { try { session.onExit(sid, exitCode); } catch (_) {} }
    });

    return { ok: true, sid, seq: session.seq };
  }

  // Sessions still alive for a peer (for reattach on reopen).
  list(peerId) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.peerId === peerId) out.push({ sid: s.sid, seq: s.seq, cols: s.cols, rows: s.rows });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // Rebind a live session's output to a new client and hand back the replay
  // buffer so they can repaint the current screen. Verifies peer ownership.
  attach(sid, { peerId, cols, rows, onData, onExit }) {
    const s = this.sessions.get(sid);
    if (!s) return { ok: false, error: 'session no longer exists' };
    if (s.peerId !== peerId) return { ok: false, error: 'not your session' };
    s.attached = true;
    s.sink = onData || null;
    s.onExit = onExit || null;
    s.lastActivity = Date.now();
    if (cols && rows) {
      s.cols = clampDim(cols, 80); s.rows = clampDim(rows, 24);
      try { s.pty.resize(s.cols, s.rows); } catch (_) {}
    }
    return { ok: true, sid, seq: s.seq, buffer: s.buf };
  }

  // Detach a session: keep the PTY running, stop streaming, keep buffering.
  detach(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    s.attached = false;
    s.sink = null;
    s.onExit = null;
    s.lastActivity = Date.now();
  }

  // Detach every session a peer owns — called when that peer's link drops, so
  // their shells keep running instead of dying with the connection.
  detachPeer(peerId) {
    for (const s of this.sessions.values()) if (s.peerId === peerId) this.detach(s.sid);
  }

  owns(peerId, sid) {
    const s = this.sessions.get(sid);
    return !!s && s.peerId === peerId;
  }

  // Do we own this session at all? Used by sync.js to tell executor-role
  // term-data (keystrokes for our PTY) from client-role (output to render).
  has(sid) {
    return this.sessions.has(sid);
  }

  write(sid, data) {
    const s = this.sessions.get(sid);
    if (!s) return;
    try { s.pty.write(data); } catch (_) {}
  }

  resize(sid, cols, rows) {
    const s = this.sessions.get(sid);
    if (!s) return;
    s.cols = clampDim(cols, 80); s.rows = clampDim(rows, 24);
    try { s.pty.resize(s.cols, s.rows); } catch (_) {}
  }

  // Explicitly KILL a session (the client's per-tab ✕).
  close(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    try { s.pty.kill(); } catch (_) {}
  }

  // Kill every session a peer owns (not used on a normal disconnect anymore —
  // that detaches; kept for completeness / forced teardown).
  closePeer(peerId) {
    for (const [sid, s] of this.sessions) {
      if (s.peerId === peerId) { this.sessions.delete(sid); try { s.pty.kill(); } catch (_) {} }
    }
  }

  // Kill everything (app shutdown).
  closeAll() {
    clearInterval(this._reaper);
    for (const [, s] of this.sessions) { try { s.pty.kill(); } catch (_) {} }
    this.sessions.clear();
  }

  // Kill detached sessions that have produced no output for a long time.
  _reap() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (!s.attached && (now - s.lastActivity) > IDLE_REAP_MS) {
        this.sessions.delete(sid);
        try { s.pty.kill(); } catch (_) {}
      }
    }
  }
}

// PTY dimensions must be sane positive integers; xterm can briefly report 0.
function clampDim(n, fallback) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

module.exports = { TerminalManager };
