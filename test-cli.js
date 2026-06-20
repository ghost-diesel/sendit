// Tests the CLI control server end-to-end: GET /peers and POST /run drive a
// real action on a connected executor, with token gating.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Sync } = require('./src/sync');
const { Actions } = require('./src/actions');
const { startCliServer } = require('./src/cliserver');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendit-cli-'));
fs.writeFileSync(path.join(tmp, 'a.json'), JSON.stringify({
  enabled: true,
  actions: [{ id: 'echo', label: 'Echo', command: 'echo cli-ran-it', confirm: false }],
}));

const PAIR = 'CLI-PAIR';
const exec = new Sync({ id: 'eeee-x', name: 'CloudCore', wsPort: 51818, discoveryPort: 51817 });
const ctrl = new Sync({ id: 'cccc-x', name: 'Mac', wsPort: 51819, discoveryPort: 51817 });
const eActions = new Actions({ file: path.join(tmp, 'a.json'), logFile: path.join(tmp, 'a.log') });
exec.setActionsProvider({ publicState: () => ({ enabled: eActions.enabled, list: eActions.publicList() }), run: (id, s, cb) => eActions.run(id, s, cb), pairingToken: () => PAIR, peerToken: () => '' });
ctrl.setActionsProvider({ publicState: () => ({ enabled: false, list: [] }), run: (i, s, cb) => cb({ ok: false }), pairingToken: () => 'x', peerToken: () => PAIR });

const TOKEN = 'cli-secret';
const PORT = 51820;
const server = startCliServer({ port: PORT, token: TOKEN, sync: ctrl });

function api(method, p, body, token = TOKEN) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'x-sendit-token': token };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
    });
    if (data) r.write(data); r.end();
  });
}

const checks = [];
const check = (n, p) => checks.push([n, p]);

exec.start(); ctrl.start();

setTimeout(async () => {
  const bad = await api('GET', '/peers', null, 'WRONG');
  check('wrong token rejected (403)', bad.status === 403);

  const peers = await api('GET', '/peers');
  check('list shows connected peer + action', peers.json.peers && peers.json.peers[0] && peers.json.peers[0].actions[0].id === 'echo');

  const run = await api('POST', '/run', { action: 'echo' });
  check('run executes and returns output', run.json.ok === true && /cli-ran-it/.test(run.json.output || ''));

  const missing = await api('POST', '/run', { action: 'nope' });
  check('unknown action rejected', missing.status === 404);

  console.log('\n=== CLI control server ===');
  let all = true;
  for (const [n, p] of checks) { console.log(`${p ? '✅' : '❌'} ${n}`); if (!p) all = false; }
  server.close(); exec.stop(); ctrl.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(all ? '\n✅ PASS' : '\n❌ FAIL');
  process.exit(all ? 0 : 1);
}, 2800);
