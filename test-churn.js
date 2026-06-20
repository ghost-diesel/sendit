// Reproduces connection churn: both peers discover each other via UDP AND the
// "Mac" also has a manual peer to "CloudCore" — the dual-dial that made the
// live connection get replaced every 2s. With the fix it must settle to ONE
// stable connection (no repeated dialing/replacing after the initial connect).
const { Sync } = require('./src/sync');

const DISC = 51867; // shared discovery port → they find each other
const cc = new Sync({ id: 'aaaa-cc', name: 'CloudCore', wsPort: 51868, discoveryPort: DISC });
const mac = new Sync({ id: 'zzzz-mac', name: 'Mac', wsPort: 51869, discoveryPort: DISC, manualPeers: ['127.0.0.1:51868'] });
const off = { publicState: () => ({ enabled: false, list: [] }), run: (i, s, cb) => cb({ ok: false }), pairingToken: () => 'x', peerToken: () => '' };
cc.setActionsProvider(off); mac.setActionsProvider(off);

let settleTime = 0;
let dialsAfterSettle = 0;
let replacesAfterSettle = 0;
let connected = false;

function watch(node) {
  node.on('status', (s) => { if (s.connected && !connected) { connected = true; settleTime = Date.now(); } });
  node.on('log', (m) => {
    // Count churn signals that happen >1.5s after first connect (post-settle).
    if (settleTime && Date.now() - settleTime > 3500) {
      if (/→ connecting/.test(m)) dialsAfterSettle++;
      if (/replacing stale link/.test(m)) replacesAfterSettle++;
    }
  });
}
watch(cc); watch(mac);

cc.start(); mac.start();

setTimeout(() => {
  const ok = connected && dialsAfterSettle === 0 && replacesAfterSettle === 0
    && mac.peers.size === 1 && cc.peers.size === 1;
  console.log('\n=== churn check ===');
  console.log(`connected: ${connected}`);
  console.log(`dial attempts after settle (want 0): ${dialsAfterSettle}`);
  console.log(`"replacing stale link" after settle (want 0): ${replacesAfterSettle}`);
  console.log(`mac peers: ${mac.peers.size}, cc peers: ${cc.peers.size} (want 1 each)`);
  cc.stop(); mac.stop();
  console.log(ok ? '\n✅ PASS — connection settles, no churn' : '\n❌ FAIL — still churning');
  process.exit(ok ? 0 : 1);
}, 9000);
