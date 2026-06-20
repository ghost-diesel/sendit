// Reproduces the Mac→CloudCore manual-peer path in isolation: different
// discovery ports (so UDP can't connect them) — the ONLY way they can meet is
// the manual peer dial. Also confirms a controller with Trusted Actions OFF
// still connects (req #7) and the manual path works without mDNS (req #3).
const { Sync, newId } = require('./src/sync');

// "CloudCore": listens, no manual peer.
const cc = new Sync({ id: 'eeee-cc', name: 'CloudCore', wsPort: 51858, discoveryPort: 51857 });
// "Mac": controller, Trusted Actions OFF, manual peer points at CloudCore:port.
const mac = new Sync({ id: 'cccc-mac', name: 'Mac', wsPort: 51859, discoveryPort: 51856, manualPeers: ['127.0.0.1:51858'] });

// Both have providers but neither needs to be "enabled" to connect.
const off = { publicState: () => ({ enabled: false, list: [] }), run: (i, s, cb) => cb({ ok: false }), pairingToken: () => 'x', peerToken: () => '' };
cc.setActionsProvider(off);
mac.setActionsProvider(off);

let macConn = false, ccConn = false, noteOk = false;
mac.on('status', (s) => { if (s.connected) macConn = true; });
cc.on('status', (s) => { if (s.connected) ccConn = true; });
cc.on('incoming', (n) => { if (n.text === 'hi via manual') noteOk = true; });
mac.on('log', (m) => console.log('[Mac]', m));

cc.start();
mac.start();

setTimeout(() => {
  mac.publishNote({ id: newId(), type: 'text', text: 'hi via manual', origin: { id: mac.id, name: 'Mac' }, createdAt: Date.now() });
}, 3000);

setTimeout(() => {
  console.log('\n=== manual-peer path (no mDNS) ===');
  console.log(`${macConn ? '✅' : '❌'} Mac (controller, actions OFF) connected`);
  console.log(`${ccConn ? '✅' : '❌'} CloudCore connected`);
  console.log(`${noteOk ? '✅' : '❌'} note synced over manual link`);
  const ok = macConn && ccConn && noteOk;
  mac.stop(); cc.stop();
  console.log(ok ? '\n✅ PASS — manual peer connects without discovery, controller needs no actions' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
}, 5500);
