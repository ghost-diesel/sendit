#!/usr/bin/env node
'use strict';

// `send-it` — drive the running Send It app from the terminal (Phase 3).
// Talks to the app's local-only control API. Lets you (and coding agents like
// Claude Code / Codex) trigger a connected machine's trusted actions.
//
//   send-it list                         list connected machines + their actions
//   send-it run <action-id> [--on <name>]  run an action on a connected machine
//
// Exit code mirrors the remote action's exit code, so scripts can branch on it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function fail(msg) { console.error('send-it: ' + msg); process.exit(1); }

const infoFile = path.join(os.homedir(), '.send-it-cli.json');
let info;
try {
  info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
} catch (_) {
  fail('cannot reach Send It — is the app running? (open the Send It app first)');
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'x-sendit-token': info.token };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: info.port, path: p, method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }); } catch (_) { resolve({ status: res.statusCode, json: {} }); } });
    });
    r.on('error', () => reject(new Error('cannot reach Send It on 127.0.0.1:' + info.port + ' — is the app running?')));
    if (data) r.write(data);
    r.end();
  });
}

const [, , cmd, ...rest] = process.argv;

(async () => {
  if (cmd === 'list' || cmd === 'ls') {
    const { json } = await req('GET', '/peers');
    if (!json.peers || !json.peers.length) return console.log('No machines connected.');
    for (const p of json.peers) {
      console.log(`\n${p.name || p.peerId}${p.enabled ? '' : '  (actions disabled there)'}`);
      if (!p.actions || !p.actions.length) { console.log('  (no actions)'); continue; }
      for (const a of p.actions) console.log(`  ${a.id}${a.danger ? '  ⚠' : ''}${a.label ? '  — ' + a.label : ''}`);
    }
    return;
  }

  if (cmd === 'run') {
    const action = rest.find((a) => !a.startsWith('--'));
    const onIdx = rest.indexOf('--on');
    const peer = onIdx >= 0 ? rest[onIdx + 1] : undefined;
    if (!action) fail('usage: send-it run <action-id> [--on <machine>]');
    const { status, json } = await req('POST', '/run', { action, peer });
    if (status !== 200) fail(json.error || ('request failed (' + status + ')'));
    if (json.output) console.log(json.output);
    if (!json.ok) {
      console.error(`✕ ${action} failed${json.code != null ? ` (exit ${json.code})` : ''}${json.error ? ': ' + json.error : ''}`);
      process.exit(json.code || 1);
    }
    console.log(`✓ ${action}${json.code != null ? ` (exit ${json.code})` : ''}`);
    return;
  }

  console.log('send-it — control Send It from the terminal\n');
  console.log('  send-it list                          list connected machines + their actions');
  console.log('  send-it run <action-id> [--on <name>] run an action on a connected machine\n');
  if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
})().catch((e) => fail(e.message));
