// End-to-end test of the Remote Terminal network slice between two Sync
// instances: terminal-state advertisement, pairing-token gating, opening a
// real PTY on the "executor", streaming a command's output back, and a
// wrong-code rejection. Mirrors test-actions-net.js.
const { Sync } = require('./src/sync');
const { TerminalManager } = require('./src/terminal');

const PAIR = 'PAIR-CODE';
const exec = new Sync({ id: 'eeee-exec', name: 'CloudCore', wsPort: 51818, discoveryPort: 51817 });
const ctrl = new Sync({ id: 'cccc-ctrl', name: 'Mac', wsPort: 51819, discoveryPort: 51817 });

// Executor exposes a shell, gated by PAIR. (Matches the main.js provider bridge.)
const term = new TerminalManager();
let termEnabled = true;
exec.setTerminalProvider({
  enabled: () => termEnabled && term.available(),
  pairingToken: () => PAIR,
  open: (opts) => term.open(opts),
  write: (sid, data) => term.write(sid, data),
  resize: (sid, cols, rows) => term.resize(sid, cols, rows),
  close: (sid) => term.close(sid),
  has: (sid) => term.has(sid),
  closePeer: (peerId) => term.closePeer(peerId),
});

// Controller signs term-open with the peer's code (peerToken), like the GUI.
let ctrlToken = PAIR;
ctrl.setActionsProvider({
  publicState: () => ({ enabled: false, list: [] }),
  run: (id, s, cb) => cb({ ok: false, error: 'n/a' }),
  pairingToken: () => 'CTRL-OWN',
  peerToken: () => ctrlToken,
});

if (!term.available()) {
  console.log('⚠️  node-pty not loaded on this runtime — skipping Remote Terminal test.');
  console.log('   (' + (term.unavailableReason() || 'unknown') + ')');
  console.log('   Run `npm run rebuild` if testing under Electron; CI builds rebuild it for the package.');
  process.exit(0);
}

const checks = [];
const check = (n, p) => checks.push([n, p]);

let execPeerId = null;
ctrl.on('peer-terminal', (pt) => {
  if (pt.enabled) {
    execPeerId = pt.peerId;
    check('controller saw executor advertise a shell', pt.enabled === true);
  }
});

const opened = [];
const dataChunks = [];
const exits = [];
ctrl.on('term-opened', (t) => opened.push(t));
ctrl.on('term-data', (t) => { if (t.data) dataChunks.push(t.data); });
ctrl.on('term-exit', (t) => exits.push(t));

exec.start();
ctrl.start();

let goodSid = null;

// Step 1: paired open should succeed and give us a session id.
setTimeout(() => { if (execPeerId) ctrl.sendTermOpen(execPeerId, 80, 24); }, 2500);

// Step 2: once open, type a command into the PTY.
setTimeout(() => {
  const ok = opened.find((o) => o.ok);
  if (ok) { goodSid = ok.sid; ctrl.sendTermData(execPeerId, goodSid, 'echo terminal-works\r'); }
}, 3500);

// Step 3: wrong pairing code must be rejected (no session).
setTimeout(() => { ctrlToken = 'WRONG'; if (execPeerId) ctrl.sendTermOpen(execPeerId, 80, 24); }, 4500);

setTimeout(() => {
  const okOpen = opened.find((o) => o.ok && o.sid);
  check('paired term-open returned a session id', !!okOpen);

  const output = dataChunks.join('');
  check('command output streamed back from the real PTY', /terminal-works/.test(output));

  const denied = opened.find((o) => o.ok === false && /not paired/.test(o.error || ''));
  check('wrong pairing code rejected', !!denied);

  // Closing the session should terminate the shell on the executor.
  if (goodSid) ctrl.sendTermClose(execPeerId, goodSid);

  setTimeout(() => {
    check('no orphan sessions left on executor after close', term.sessions.size === 0);

    console.log('\n=== Remote Terminal network ===');
    let all = true;
    for (const [n, p] of checks) { console.log(`${p ? '✅' : '❌'} ${n}`); if (!p) all = false; }
    term.closeAll(); exec.stop(); ctrl.stop();
    console.log(all ? '\n✅ PASS — advertise, token gating, PTY stream, teardown all work' : '\n❌ FAIL');
    process.exit(all ? 0 : 1);
  }, 700);
}, 6000);
