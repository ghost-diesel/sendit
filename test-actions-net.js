// End-to-end test of the Trusted Actions network slice between two Sync
// instances: action-list exchange, pairing-token gating, run, and result.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sync, newId } = require('./src/sync');
const { Actions } = require('./src/actions');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendit-net-'));
const eFile = path.join(tmp, 'actions.json');
fs.writeFileSync(eFile, JSON.stringify({
  enabled: true,
  actions: [{ id: 'echo', label: 'Echo', command: 'echo run-on-executor', confirm: false }],
}));

const PAIR = 'PAIR-CODE';
const exec = new Sync({ id: 'eeee-exec', name: 'CloudCore', wsPort: 51808, discoveryPort: 51807 });
const ctrl = new Sync({ id: 'cccc-ctrl', name: 'Mac', wsPort: 51809, discoveryPort: 51807 });

const eActions = new Actions({ file: eFile, logFile: path.join(tmp, 'a.log') });
exec.setActionsProvider({
  publicState: () => ({ enabled: eActions.enabled, list: eActions.publicList() }),
  run: (id, src, cb) => eActions.run(id, src, cb),
  pairingToken: () => PAIR,
  peerToken: () => '',
});

let ctrlToken = PAIR; // start paired correctly
ctrl.setActionsProvider({
  publicState: () => ({ enabled: false, list: [] }),
  run: (id, s, cb) => cb({ ok: false, error: 'n/a' }),
  pairingToken: () => 'CTRL-OWN',
  peerToken: () => ctrlToken,
});

const checks = [];
const check = (n, p) => checks.push([n, p]);
let execPeerId = null;

ctrl.on('peer-actions', (pa) => {
  if (pa.list && pa.list.length) {
    execPeerId = pa.peerId;
    check('controller received executor action list', pa.enabled === true && pa.list[0].id === 'echo');
    check('action list carries no command text', !('command' in pa.list[0]));
  }
});

const results = [];
ctrl.on('run-result', (r) => results.push(r));

exec.start();
ctrl.start();

// Step 1: paired run should succeed.
setTimeout(() => { if (execPeerId) ctrl.sendRun(execPeerId, 'echo'); }, 2500);
// Step 2: unpaired (wrong code) run should be rejected.
setTimeout(() => { ctrlToken = 'WRONG'; if (execPeerId) ctrl.sendRun(execPeerId, 'echo'); }, 4000);

setTimeout(() => {
  const ok = results.find((r) => r.ok === true);
  const denied = results.find((r) => r.ok === false && /not paired/.test(r.error || ''));
  check('paired run executed on executor', !!ok && /run-on-executor/.test(ok.output || ''));
  check('wrong pairing code rejected', !!denied);

  console.log('\n=== Trusted Actions network ===');
  let all = true;
  for (const [n, p] of checks) { console.log(`${p ? '✅' : '❌'} ${n}`); if (!p) all = false; }
  exec.stop(); ctrl.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(all ? '\n✅ PASS — list exchange, token gating, run, result all work' : '\n❌ FAIL');
  process.exit(all ? 0 : 1);
}, 6000);
