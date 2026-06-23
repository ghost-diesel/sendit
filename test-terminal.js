// End-to-end test of the Remote Terminal network slice between two Sync
// instances: terminal-state advertisement, pairing-token gating, opening a real
// PTY on the "executor", streaming output back, a wrong-code rejection, and the
// PERSISTENCE path — detach (keep alive) → list → reattach → buffer replay →
// explicit kill. Mirrors test-actions-net.js.
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
  owns: (peerId, sid) => term.owns(peerId, sid),
  list: (peerId) => term.list(peerId),
  attach: (sid, opts) => term.attach(sid, opts),
  detach: (sid) => term.detach(sid),
  detachPeer: (peerId) => term.detachPeer(peerId),
});

// Controller signs requests with the peer's code (peerToken), like the GUI.
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
const exits = [];
let allData = '';      // everything streamed back
let replay = '';       // data captured after we reattach (the buffer burst)
let capturingReplay = false;
let sessionList = null;
let attached = null;
let aliveWhileDetached = null;

ctrl.on('term-opened', (t) => opened.push(t));
ctrl.on('term-data', (t) => { if (t.data) { allData += t.data; if (capturingReplay) replay += t.data; } });
ctrl.on('term-exit', (t) => exits.push(t));
ctrl.on('term-sessions', (t) => { sessionList = t.sessions || []; });
ctrl.on('term-attached', (t) => { attached = t; });

exec.start();
ctrl.start();

let sid = null;

const steps = [
  // 1. Paired open succeeds.
  [2500, () => ctrl.sendTermOpen(execPeerId, 80, 24)],
  // 2. Run a command whose output we'll later expect to see REPLAYED.
  [3500, () => { const o = opened.find((x) => x.ok); if (o) { sid = o.sid; ctrl.sendTermData(execPeerId, sid, 'echo PERSIST-MARKER\r'); } }],
  // 3. Wrong code is rejected.
  [4500, () => { ctrlToken = 'WRONG'; ctrl.sendTermOpen(execPeerId, 80, 24); ctrlToken = PAIR; }],
  // 4. Detach — the shell must KEEP RUNNING (not be killed).
  [5200, () => { ctrl.sendTermDetach(execPeerId, sid); }],
  // 5. List sessions — the detached one should still be there (and alive).
  [5900, () => { aliveWhileDetached = term.sessions.size; ctrl.sendTermList(execPeerId); }],
  // 6. Reattach — expect the buffered screen (with our marker) to replay.
  [6600, () => { capturingReplay = true; ctrl.sendTermAttach(execPeerId, sid, 100, 30); }],
  // 7. Explicit kill.
  [8000, () => ctrl.sendTermClose(execPeerId, sid)],
];
for (const [t, fn] of steps) setTimeout(() => { if (execPeerId) fn(); }, t);

setTimeout(() => {
  check('paired term-open returned a session id', opened.some((o) => o.ok && o.sid));
  check('command output streamed back from the real PTY', /PERSIST-MARKER/.test(allData));
  check('wrong pairing code rejected', opened.some((o) => o.ok === false && /not paired/.test(o.error || '')));
  check('detached shell stays alive on executor', aliveWhileDetached === 1);
  check('list returns the detached session', !!sessionList && sessionList.some((s) => s.sid === sid));
  check('reattach acknowledged', !!attached && attached.ok === true);
  check('reattach replays the buffered screen', /PERSIST-MARKER/.test(replay));
  check('explicit kill removes the session', term.sessions.size === 0);

  console.log('\n=== Remote Terminal network ===');
  let all = true;
  for (const [n, p] of checks) { console.log(`${p ? '✅' : '❌'} ${n}`); if (!p) all = false; }
  term.closeAll(); exec.stop(); ctrl.stop();
  console.log(all ? '\n✅ PASS — advertise, gating, stream, persistence (detach/list/reattach/replay), kill' : '\n❌ FAIL');
  process.exit(all ? 0 : 1);
}, 9000);
