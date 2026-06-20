// Tests the Trusted Actions core: allow-list enforcement, enable-gating,
// no command leakage over the public list, execution, and timeouts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Actions } = require('./src/actions');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendit-actions-'));
const file = path.join(tmp, 'actions.json');
const logFile = path.join(tmp, 'actions.log');

fs.writeFileSync(file, JSON.stringify({
  enabled: true,
  actions: [
    { id: 'echo-hi', label: 'Echo Hi', command: 'echo hello-from-action', confirm: false },
    { id: 'slow', label: 'Slow', command: 'sleep 5', timeout: 500 },
    { id: 'restart-server', label: 'Restart Server', command: 'echo restarting', danger: true },
  ],
}));

const results = {};
const checks = [];
function check(name, pass) { checks.push([name, pass]); }

const A = new Actions({ file, logFile });

// 1) public list must NOT contain command text
const pub = A.publicList();
check('public list hides command text', pub.every((a) => !('command' in a)));
check('public list keeps id/label/flags', pub[0].id === 'echo-hi' && pub[2].danger === true);
check('confirm defaults to true when omitted', A.actions.get('slow').confirm === true);

let pending = 4;
function maybeDone() { if (--pending === 0) report(); }

// 2) known action runs and returns output
A.run('echo-hi', { id: 'peer1', name: 'Mac' }, (r) => {
  check('known action runs (ok)', r.ok === true && r.code === 0);
  check('captures output', /hello-from-action/.test(r.output || ''));
  maybeDone();
});

// 3) unknown id is rejected (NOT executed)
A.run('rm-rf-everything', { id: 'peer1', name: 'Mac' }, (r) => {
  check('unknown id rejected', r.ok === false && /Unknown action/.test(r.error));
  maybeDone();
});

// 4) when disabled, nothing runs
const B = new Actions({ file, logFile });
B.setEnabled(false);
B.run('echo-hi', null, (r) => {
  check('disabled machine refuses to run', r.ok === false && /disabled/.test(r.error));
  maybeDone();
});

// 5) timeout kills a long command
A.run('slow', null, (r) => {
  check('long command times out', r.ok === false && /timed out/.test(r.error || ''));
  maybeDone();
});

function report() {
  console.log('\n=== Trusted Actions core ===');
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? '✅' : '❌'} ${name}`);
    if (!pass) allPass = false;
  }
  // audit log should have entries
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
  const logged = log.length >= 3 && log.every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  console.log(`${logged ? '✅' : '❌'} audit log written (${log.length} entries)`);
  allPass = allPass && logged;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(allPass ? '\n✅ PASS — allow-list, gating, no-leak, exec, timeout all hold' : '\n❌ FAIL');
  process.exit(allPass ? 0 : 1);
}
