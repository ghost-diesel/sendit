// End-to-end test of discovery + connect + note sync, two instances in one
// process (different WS ports, shared broadcast discovery port).
const { Sync, newId } = require('./src/sync');

const a = new Sync({ id: 'aaaa-' + newId(), name: 'machine-A', wsPort: 50778, discoveryPort: 50777 });
const b = new Sync({ id: 'bbbb-' + newId(), name: 'machine-B', wsPort: 50779, discoveryPort: 50777 });

let aConnected = false, bConnected = false, bGotNote = false;

a.on('log', (m) => console.log('[A]', m));
b.on('log', (m) => console.log('[B]', m));
a.on('status', (s) => { if (s.connected && !aConnected) { aConnected = true; console.log('[A] status: connected to', s.peers); } });
b.on('status', (s) => { if (s.connected && !bConnected) { bConnected = true; console.log('[B] status: connected to', s.peers); } });
b.on('incoming', (note) => { bGotNote = true; console.log('[B] RECEIVED NOTE:', JSON.stringify(note.text)); });

a.start();
b.start();

// After they should be connected, A publishes a note.
setTimeout(() => {
  console.log('\n--- A publishes a note ---');
  a.publishNote({ id: newId(), type: 'text', text: 'hello from A → B', origin: { id: a.id, name: 'machine-A' }, createdAt: Date.now() });
}, 4000);

setTimeout(() => {
  console.log('\n=== RESULT ===');
  console.log('A connected:', aConnected);
  console.log('B connected:', bConnected);
  console.log('B received the note:', bGotNote);
  const ok = aConnected && bConnected && bGotNote;
  console.log(ok ? '\n✅ PASS — discovery + connect + sync all work' : '\n❌ FAIL');
  a.stop(); b.stop();
  process.exit(ok ? 0 : 1);
}, 7000);
