'use strict';

// Local-only control API for the `send-it` CLI (Phase 3).
//
// Bound to 127.0.0.1 ONLY (never network-exposed) and gated by a token that
// lives in a 0600 file in the user's home dir — so only local processes that
// can read that file (the user, their shell, their coding agents) can drive
// the running app. It does not add any new remote capability: it just lets the
// terminal trigger the same action runs the GUI already can.

const http = require('http');

function startCliServer({ port, token, sync, onLog }) {
  const pending = new Map(); // reqId -> { res, timer }

  sync.on('run-result', (r) => {
    const p = pending.get(r.reqId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(r.reqId);
    sendJson(p.res, 200, { ok: r.ok, code: r.code, output: r.output, error: r.error, action: r.id });
  });

  const server = http.createServer((req, res) => {
    if (req.headers['x-sendit-token'] !== token) return sendJson(res, 403, { error: 'forbidden' });

    if (req.method === 'GET' && req.url.startsWith('/peers')) {
      const peers = sync.peerActionsSnapshot().map((p) => ({
        peerId: p.peerId, name: p.name, enabled: p.enabled, actions: p.list,
      }));
      return sendJson(res, 200, { peers });
    }

    if (req.method === 'POST' && req.url.startsWith('/run')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let b;
        try { b = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
        const snap = sync.peerActionsSnapshot();
        let target;
        if (b.peer) {
          const want = String(b.peer).toLowerCase();
          target = snap.find((p) => p.peerId === b.peer || (p.name && p.name.toLowerCase() === want));
        } else if (snap.length === 1) {
          target = snap[0];
        }
        if (!target) return sendJson(res, 404, { error: snap.length ? 'multiple machines connected — pass --on <machine>' : 'no machine connected' });
        if (!(target.list || []).some((a) => a.id === b.action)) {
          return sendJson(res, 404, { error: `no action "${b.action}" on ${target.name}` });
        }
        const reqId = sync.sendRun(target.peerId, b.action);
        if (!reqId) return sendJson(res, 502, { error: 'could not send to peer' });
        const timer = setTimeout(() => { pending.delete(reqId); sendJson(res, 504, { error: 'timed out waiting for result' }); }, 60000);
        pending.set(reqId, { res, timer });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.on('error', (e) => onLog && onLog('cli server error: ' + e.message));
  server.listen(port, '127.0.0.1');
  return server;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = { startCliServer };
