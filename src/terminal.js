'use strict';

// Executor-side PTY manager for the embedded Remote Terminal feature.
//
// SAFETY MODEL (see docs/TERMINAL.md) — mirrors Trusted Actions:
//  - A real PTY shell is spawned ONLY on the machine the user explicitly
//    enabled it on (`terminalEnabled` in config, OFF by default). This is a
//    SEPARATE switch from Trusted Actions.
//  - Every `term-open` is gated by the same pairing code as Trusted Actions
//    (validated in sync.js, exactly like _handleRun). Unpaired peers get
//    nothing.
//  - The shell runs as the current user with no privilege escalation. When a
//    peer disconnects, all of its PTYs are killed.
//  - node-pty is a NATIVE module. We require it lazily inside a try/catch so a
//    missing or ABI-mismatched build cleanly DISABLES the feature with a clear
//    message instead of crashing the whole app.

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

const MAX_SESSIONS_PER_PEER = 8; // guard against a runaway client opening tabs

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sid -> { pty, peerId }
  }

  // True only if the native module loaded — the GUI uses this to show a clear
  // "terminal unavailable on this build" message instead of failing silently.
  available() {
    return !!loadPty();
  }

  unavailableReason() {
    if (this.available()) return null;
    return loadError
      ? 'node-pty failed to load on this build: ' + (loadError.message || loadError)
      : 'node-pty is not installed on this machine';
  }

  // Spawn a PTY. `onData(sid, data)` streams shell output; `onExit(sid, code)`
  // fires once. Returns { ok, sid } or { ok:false, error }.
  open({ peerId, cols, rows, onData, onExit }) {
    const lib = loadPty();
    if (!lib) return { ok: false, error: this.unavailableReason() };

    // Per-peer cap so a misbehaving client can't exhaust the machine.
    let count = 0;
    for (const s of this.sessions.values()) if (s.peerId === peerId) count++;
    if (count >= MAX_SESSIONS_PER_PEER) {
      return { ok: false, error: `too many terminal sessions (max ${MAX_SESSIONS_PER_PEER})` };
    }

    const sid = crypto.randomUUID();
    let child;
    try {
      child = lib.spawn(defaultShell(), [], {
        name: 'xterm-256color',
        cols: clampDim(cols, 80),
        rows: clampDim(rows, 24),
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', SENDIT_TERMINAL: '1' },
      });
    } catch (e) {
      return { ok: false, error: 'failed to start shell: ' + e.message };
    }

    this.sessions.set(sid, { pty: child, peerId });

    child.onData((data) => {
      try { onData(sid, data); } catch (_) {}
    });
    child.onExit(({ exitCode }) => {
      this.sessions.delete(sid);
      try { onExit(sid, exitCode); } catch (_) {}
    });

    return { ok: true, sid };
  }

  // Do we own this session? Used to tell "keystrokes for our PTY" (executor
  // role) apart from "output for our renderer" (client role) on the shared
  // term-data message kind — session ids are UUIDs, so this is unambiguous.
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
    try { s.pty.resize(clampDim(cols, 80), clampDim(rows, 24)); } catch (_) {}
  }

  close(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    try { s.pty.kill(); } catch (_) {}
  }

  // Kill every session owned by a peer — called when that peer disconnects so
  // we never leave an orphan shell running for a link that's gone.
  closePeer(peerId) {
    for (const [sid, s] of this.sessions) {
      if (s.peerId === peerId) {
        this.sessions.delete(sid);
        try { s.pty.kill(); } catch (_) {}
      }
    }
  }

  // Kill everything (app shutdown).
  closeAll() {
    for (const [, s] of this.sessions) { try { s.pty.kill(); } catch (_) {} }
    this.sessions.clear();
  }
}

// PTY dimensions must be sane positive integers; xterm can briefly report 0.
function clampDim(n, fallback) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

module.exports = { TerminalManager };
