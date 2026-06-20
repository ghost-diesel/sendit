// Verifies the reconnect fix: when a peer connects again with an id we already
// hold (a stale/dead link), the new connection REPLACES the old one instead of
// being rejected — and notes flow to the new connection.
const { Sync, newId } = require('./src/sync');
const { WebSocket } = require('ws');

const PORT = 51799;
const a = new Sync({ id: 'aaaa-host', name: 'host', wsPort: PORT, discoveryPort: 51798 });
a.start();

const PEER_ID = 'zzzz-peer'; // > host id, so host won't dial; we drive the client

function connectAs(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.label = label;
  ws.on('open', () => ws.send(JSON.stringify({ kind: 'hello', proto: 2, id: PEER_ID, name: 'peer-' + label })));
  return ws;
}

let c1Closed = false;
let c2GotNote = false;

setTimeout(() => {
  const c1 = connectAs('first');
  c1.on('close', () => { c1Closed = true; console.log('[c1] closed (expected — replaced)'); });
  c1.on('message', (m) => { const x = JSON.parse(m); if (x.kind === 'hello') console.log('[c1] got hello from host'); });

  // Simulate a reconnect ~1.5s later with the SAME id (old link still "held").
  setTimeout(() => {
    console.log('--- peer reconnects with same id ---');
    const c2 = connectAs('second');
    c2.on('message', (m) => {
      const x = JSON.parse(m);
      if (x.kind === 'hello') console.log('[c2] got hello from host (accepted, not rejected)');
      if (x.kind === 'note') { c2GotNote = true; console.log('[c2] received note:', JSON.stringify(x.note.text)); }
    });

    // After c2 is established, host publishes a note — should reach c2.
    setTimeout(() => {
      console.log('--- host publishes a note ---');
      a.publishNote({ id: newId(), type: 'text', text: 'to the live peer', origin: { id: a.id, name: 'host' }, createdAt: Date.now() });
    }, 800);
  }, 1500);
}, 400);

setTimeout(() => {
  const peerCount = a.peers.size;
  console.log('\n=== RESULT ===');
  console.log('host peer count (should be 1):', peerCount);
  console.log('old connection closed:', c1Closed);
  console.log('new connection received note:', c2GotNote);
  const ok = peerCount === 1 && c1Closed && c2GotNote;
  console.log(ok ? '\n✅ PASS — reconnect replaces stale link, notes flow to new connection' : '\n❌ FAIL');
  a.stop();
  process.exit(ok ? 0 : 1);
}, 4200);
