'use strict';

// Local action registry + executor for Trusted Actions.
//
// SAFETY MODEL (see docs/TRUSTED_ACTIONS.md):
//  - Commands are defined ONLY in this machine's local actions.json. Callers
//    (including remote peers) pass an action *id*, never a command string.
//  - Execution is OFF unless `enabled` is true on THIS machine.
//  - Unknown ids are rejected. Everything is appended to an audit log.
//  - Runs as the current user; no privilege escalation; output is capped and
//    each run is time-limited.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_OUTPUT = 8 * 1024; // cap captured stdout+stderr returned to a peer
const DEFAULT_TIMEOUT = 30000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i; // safe, stable wire identifiers

function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

class Actions {
  constructor({ file, logFile }) {
    this.file = file;
    this.logFile = logFile;
    this.enabled = false;
    this.actions = new Map(); // id -> definition (incl. local command)
    this.load();
  }

  load() {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    this.enabled = !!(data && data.enabled);
    this.actions = new Map();
    const list = data && Array.isArray(data.actions) ? data.actions : [];
    for (const a of list) {
      if (!a || !ID_RE.test(a.id || '') || !a.command) continue;
      this.actions.set(a.id, {
        id: a.id,
        label: a.label || a.id,
        command: String(a.command),
        cwd: a.cwd ? expandHome(a.cwd) : undefined,
        confirm: a.confirm !== false, // default to requiring confirmation
        danger: !!a.danger,
        timeout: Number(a.timeout) > 0 ? Number(a.timeout) : DEFAULT_TIMEOUT,
      });
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.persist();
  }

  // Upsert/remove used by the in-app editor (Phase 2).
  upsert(def) {
    if (!def || !ID_RE.test(def.id || '') || !def.command) return false;
    this.actions.set(def.id, {
      id: def.id,
      label: def.label || def.id,
      command: String(def.command),
      cwd: def.cwd ? expandHome(def.cwd) : undefined,
      confirm: def.confirm !== false,
      danger: !!def.danger,
      timeout: Number(def.timeout) > 0 ? Number(def.timeout) : DEFAULT_TIMEOUT,
    });
    this.persist();
    return true;
  }

  remove(id) {
    const ok = this.actions.delete(id);
    if (ok) this.persist();
    return ok;
  }

  persist() {
    const out = {
      enabled: this.enabled,
      actions: [...this.actions.values()].map((a) => ({
        id: a.id,
        label: a.label,
        command: a.command,
        ...(a.cwd ? { cwd: a.cwd } : {}),
        confirm: a.confirm,
        danger: a.danger,
        ...(a.timeout !== DEFAULT_TIMEOUT ? { timeout: a.timeout } : {}),
      })),
    };
    try { fs.writeFileSync(this.file, JSON.stringify(out, null, 2)); } catch (_) {}
  }

  // What we advertise to peers — labels + flags only, NEVER the command.
  publicList() {
    return [...this.actions.values()].map((a) => ({
      id: a.id,
      label: a.label,
      confirm: a.confirm,
      danger: a.danger,
    }));
  }

  // Run an allow-listed action by id. `source` = { id, name } of the requester
  // (or null for a local run) — used only for the audit log. cb(result).
  run(id, source, cb) {
    const done = (r) => { this._log(id, source, r); cb(r); };

    if (!this.enabled) return done({ ok: false, error: 'Actions are disabled on this machine' });
    const a = this.actions.get(id);
    if (!a) return done({ ok: false, error: 'Unknown action: ' + id });

    let out = '';
    let finished = false;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); done(r); };

    let child;
    try {
      child = spawn(a.command, { shell: true, cwd: a.cwd || os.homedir() });
    } catch (e) {
      return finish({ ok: false, error: 'spawn failed: ' + e.message });
    }

    const append = (buf) => {
      if (out.length >= MAX_OUTPUT) return;
      out += buf.toString().slice(0, MAX_OUTPUT - out.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, code: null, output: out, error: `timed out after ${a.timeout}ms` });
    }, a.timeout);

    child.on('error', (e) => finish({ ok: false, error: e.message, output: out }));
    child.on('close', (code) => finish({ ok: code === 0, code, output: out.trim() }));
  }

  _log(id, source, r) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      from: source ? `${source.name} (${source.id})` : 'local',
      action: id,
      ok: !!r.ok,
      code: r.code === undefined ? null : r.code,
      error: r.error || undefined,
    }) + '\n';
    try { fs.appendFileSync(this.logFile, line); } catch (_) {}
  }
}

module.exports = { Actions, DEFAULT_TIMEOUT };
