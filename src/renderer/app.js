'use strict';

const $ = (id) => document.getElementById(id);

const editor = $('editor');
const feed = $('feed');
const emptyState = $('emptyState');
const statusPill = $('statusPill');
const statusText = $('statusText');
const monoToggle = $('monoToggle');
const attachmentEl = $('attachment');

let self = { id: '', name: '', manualPeers: [] };
let localIPs = [];
let history = [];
let peerActionsState = []; // [{ peerId, name, enabled, list, paired }]
const runStates = {}; // reqId -> { peerId, actionId, label }
let pendingAttachment = null; // { type, name, mime, size, data }
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// ---------- helpers ----------
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.innerHTML = `<span class="tdot"></span>${escapeHtml(msg)}`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

// Looks-like-code heuristic for nicer rendering of incoming notes.
function looksLikeCode(text) {
  if (!text) return false;
  const lines = text.split('\n');
  const codey = /[{};=<>]|\bfunction\b|\bconst\b|\bimport\b|\bdef\b|\bclass\b|=>|\$\(|#!\//;
  return lines.length > 2 && codey.test(text);
}

// ---------- rendering ----------
function render() {
  emptyState.classList.toggle('hidden', history.length > 0);
  // Remove existing cards (keep empty state node).
  [...feed.querySelectorAll('.card')].forEach((c) => c.remove());

  for (const note of history) {
    feed.appendChild(buildCard(note));
  }
}

function buildCard(note) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = note.id;

  const mine = note.origin && note.origin.id === self.id;
  const originName = mine ? 'You' : (note.origin && note.origin.name) || 'peer';

  const top = document.createElement('div');
  top.className = 'card-top';
  top.innerHTML = `
    <span class="origin-badge ${mine ? 'me' : ''}"><span class="pip"></span>${escapeHtml(originName)}</span>
    <span class="card-time" data-ts="${note.createdAt}">${timeAgo(note.createdAt)}</span>
  `;
  card.appendChild(top);

  const body = document.createElement('div');
  if (note.type === 'image') {
    body.className = 'card-body';
    const wrap = document.createElement('div');
    wrap.className = 'card-img';
    wrap.title = 'Click to preview';
    const img = document.createElement('img');
    img.src = note.data;
    img.loading = 'lazy';
    wrap.appendChild(img);
    wrap.onclick = () => openLightbox(note);
    body.appendChild(wrap);
  } else if (note.type === 'file') {
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-file">
        <div class="fi"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M14 3v5h5M14 3l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
        <div><div class="fname">${escapeHtml(note.name || 'file')}</div><div class="fsize">${fmtSize(note.size)}</div></div>
      </div>`;
  } else {
    const mono = note.mono || looksLikeCode(note.text);
    body.className = 'card-body ' + (mono ? 'mono' : 'text');
    body.textContent = note.text || '';
  }
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (note.type === 'text') {
    const copy = chipBtn('Copy', 'good');
    copy.onclick = async () => { await window.api.copyText(note.text); toast('Copied to clipboard'); };
    actions.appendChild(copy);
  } else if (note.type === 'image') {
    const copy = chipBtn('Copy image');
    copy.onclick = async () => { await window.api.copyImage(note.data); toast('Image copied'); };
    actions.appendChild(copy);
    if (note.localPath) actions.appendChild(showInFolderChip(note));
    const save = chipBtn('Save as…');
    save.onclick = () => saveNote(note);
    actions.appendChild(save);
  } else {
    if (note.localPath) {
      const open = chipBtn('Open', 'good');
      open.onclick = async () => {
        const ok = await window.api.openFile(note.localPath);
        if (!ok) toast('File not found on disk');
      };
      actions.appendChild(open);
      actions.appendChild(showInFolderChip(note));
    }
    const save = chipBtn('Save as…');
    save.onclick = () => saveNote(note);
    actions.appendChild(save);
  }

  const del = chipBtn('Delete', 'danger');
  del.onclick = () => window.api.deleteNote(note.id);
  actions.appendChild(del);

  card.appendChild(actions);
  return card;
}

function chipBtn(label, cls = '') {
  const b = document.createElement('button');
  b.className = 'chip ' + cls;
  b.textContent = label;
  return b;
}

function showInFolderChip(note) {
  const chip = chipBtn('Show in folder');
  chip.onclick = async () => {
    const ok = await window.api.showInFolder(note.localPath);
    if (!ok) toast('File not found on disk');
  };
  return chip;
}

async function saveNote(note) {
  const path = await window.api.saveNoteFile(note);
  if (path) toast('Saved');
}

// ---------- lightbox ----------
function openLightbox(note) {
  const lb = $('lightbox');
  $('lightboxImg').src = note.data;
  const bar = $('lightboxBar');
  bar.innerHTML = '';
  const copy = chipBtn('Copy image');
  copy.onclick = async (e) => { e.stopPropagation(); await window.api.copyImage(note.data); toast('Image copied'); };
  bar.appendChild(copy);
  if (note.localPath) {
    const show = chipBtn('Show in folder');
    show.onclick = async (e) => { e.stopPropagation(); const ok = await window.api.showInFolder(note.localPath); if (!ok) toast('File not found on disk'); };
    bar.appendChild(show);
  }
  lb.classList.remove('hidden');
}

function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightboxImg').src = '';
}

// Close on backdrop click (but not when clicking the image or the action bar).
$('lightbox').addEventListener('click', (e) => {
  if (e.target === $('lightbox')) closeLightbox();
});
$('lightboxClose').onclick = closeLightbox;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) closeLightbox();
});

// Open the received-files folder.
$('openFolderBtn').onclick = () => window.api.openReceivedFolder();

// refresh relative timestamps
setInterval(() => {
  document.querySelectorAll('.card-time').forEach((el) => {
    el.textContent = timeAgo(Number(el.dataset.ts));
  });
}, 15000);

// ---------- sending ----------
function setAttachment(att) {
  pendingAttachment = att;
  if (!att) { attachmentEl.classList.add('hidden'); attachmentEl.innerHTML = ''; return; }
  attachmentEl.classList.remove('hidden');
  if (att.type === 'image') {
    attachmentEl.innerHTML = `<img src="${att.data}" /><div class="meta"><strong>Image</strong>${fmtSize(att.size)}</div><div class="x" id="attX">✕</div>`;
  } else {
    attachmentEl.innerHTML = `<div class="fi" style="width:38px;height:38px;border-radius:9px;display:grid;place-items:center;color:var(--accent);background:rgba(109,139,255,0.12)">📄</div><div class="meta"><strong>${escapeHtml(att.name)}</strong>${fmtSize(att.size)}</div><div class="x" id="attX">✕</div>`;
  }
  $('attX').onclick = () => setAttachment(null);
}

function send() {
  const text = editor.value;
  if (pendingAttachment) {
    const note = {
      id: uuid(),
      type: pendingAttachment.type,
      name: pendingAttachment.name,
      mime: pendingAttachment.mime,
      size: pendingAttachment.size,
      data: pendingAttachment.data,
      origin: { id: self.id, name: self.name },
      createdAt: Date.now(),
    };
    window.api.publishNote(note);
    setAttachment(null);
    if (text.trim()) sendText(text);
    flash('Sent it ✦');
    editor.value = '';
    return;
  }
  if (!text.trim()) return;
  sendText(text);
  editor.value = '';
  flash('Sent it ✦');
}

function sendText(text) {
  const note = {
    id: uuid(),
    type: 'text',
    text,
    mono: monoToggle.checked,
    origin: { id: self.id, name: self.name },
    createdAt: Date.now(),
  };
  window.api.publishNote(note);
}

function flash(msg) {
  toast(msg);
  const btn = $('sendBtn');
  btn.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(0.95)' }, { transform: 'scale(1)' }],
    { duration: 220, easing: 'ease' }
  );
}

function fileToNote(file) {
  if (file.size > MAX_BYTES) {
    toast(`Too big (${fmtSize(file.size)}). Max 25 MB.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const isImage = (file.type || '').startsWith('image/');
    setAttachment({
      type: isImage ? 'image' : 'file',
      name: file.name,
      mime: file.type,
      size: file.size,
      data: reader.result,
    });
  };
  reader.readAsDataURL(file);
}

// ---------- events ----------
$('sendBtn').onclick = send;

editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    send();
  }
});

monoToggle.addEventListener('change', () => {
  editor.classList.toggle('mono', monoToggle.checked);
});

// Paste images directly into the editor.
editor.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      e.preventDefault();
      fileToNote(it.getAsFile());
      return;
    }
  }
});

// "Paste clipboard" button — pulls text or image from the OS clipboard.
$('pasteBtn').onclick = async () => {
  const c = await window.api.readClipboard();
  if (c.type === 'image' && c.dataUrl) {
    setAttachment({ type: 'image', name: 'clipboard.png', mime: 'image/png', size: 0, data: c.dataUrl });
  } else if (c.text) {
    editor.value = editor.value ? editor.value + '\n' + c.text : c.text;
    editor.focus();
  } else {
    toast('Clipboard is empty');
  }
};

// Drag & drop files anywhere over the composer.
const dropZone = $('dropZone');
['dragenter', 'dragover'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove('dragover');
  })
);
dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) fileToNote(files[0]);
});

$('clearBtn').onclick = () => {
  if (history.length && confirm('Clear all history on both machines?')) {
    window.api.clearAll();
  }
};

// Settings
$('settingsBtn').onclick = () => {
  $('nameInput').value = self.name;
  $('peerInput').value = (self.manualPeers || []).join(', ');
  $('localIp').textContent = localIPs.length ? localIPs.join(', ') : 'not on a network';
  loadActionsSelf();
  $('settingsModal').classList.remove('hidden');
  $('nameInput').focus();
};
$('settingsClose').onclick = closeSettings;
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) closeSettings();
});
async function closeSettings() {
  const newName = $('nameInput').value.trim();
  if (newName && newName !== self.name) {
    self.name = await window.api.setName(newName);
    $('selfName').textContent = self.name;
  }
  const peers = $('peerInput').value;
  const saved = await window.api.setManualPeers(peers);
  self.manualPeers = saved;
  if (saved.length) toast('Saved — connecting…');
  $('settingsModal').classList.add('hidden');
}

// ---------- Trusted actions: settings controls ----------
async function loadActionsSelf() {
  const s = await window.api.actionsSelf();
  $('actionsEnableToggle').checked = !!s.enabled;
  $('pairingCode').textContent = s.pairingCode || '—';
  $('actionsCount').textContent = s.count ? `${s.count} action${s.count === 1 ? '' : 's'}` : 'no actions yet';
  const badge = $('actionsStateBadge');
  badge.textContent = s.enabled ? 'on' : 'off';
  badge.classList.toggle('on', !!s.enabled);
}
$('actionsEnableToggle').addEventListener('change', async (e) => {
  await window.api.setActionsEnabled(e.target.checked);
  await loadActionsSelf();
  toast(e.target.checked ? 'Actions enabled on this machine' : 'Actions disabled');
});
$('openActionsFileBtn').onclick = () => window.api.openActionsFile();
$('reloadActionsBtn').onclick = async () => { await window.api.reloadActions(); await loadActionsSelf(); toast('Reloaded actions.json'); };

// ---------- Trusted actions: remote panel ----------
function updateActionsDot() {
  const any = peerActionsState.some((p) => p.enabled && p.list && p.list.length);
  $('actionsDot').classList.toggle('hidden', !any);
}

$('actionsBtn').onclick = () => { renderActionsPanel(); $('actionsResult').classList.add('hidden'); $('actionsModal').classList.remove('hidden'); };
$('actionsClose').onclick = () => $('actionsModal').classList.add('hidden');
$('actionsModal').addEventListener('click', (e) => { if (e.target === $('actionsModal')) $('actionsModal').classList.add('hidden'); });

function renderActionsPanel() {
  const body = $('actionsPanelBody');
  body.innerHTML = '';
  const usable = peerActionsState.filter((p) => p.list && p.list.length);
  if (!usable.length) {
    body.innerHTML = '<div class="ap-empty">No remote actions available.<br>Connect to a machine that has <strong>Trusted actions</strong> enabled (Settings on that machine).</div>';
    return;
  }
  for (const peer of usable) {
    const sec = document.createElement('div');
    sec.className = 'ap-peer';
    const head = document.createElement('div');
    head.className = 'ap-peer-head';
    head.innerHTML = `<span class="pip"></span>Actions on ${escapeHtml(peer.name || 'peer')}`;
    sec.appendChild(head);

    if (!peer.enabled) {
      const note = document.createElement('div');
      note.className = 'ap-note';
      note.textContent = 'Actions are turned off on that machine.';
      sec.appendChild(note);
    } else if (!peer.paired) {
      const note = document.createElement('div');
      note.className = 'ap-note';
      note.textContent = `Enter ${peer.name}'s pairing code (shown in its Settings) to run these:`;
      sec.appendChild(note);
      const row = document.createElement('div');
      row.className = 'ap-pair';
      const input = document.createElement('input');
      input.placeholder = 'XXXX-XXXX';
      input.maxLength = 9;
      const btn = document.createElement('button');
      btn.className = 'chip good';
      btn.textContent = 'Pair';
      btn.onclick = async () => {
        const ok = await window.api.pairPeer(peer.peerId, input.value);
        peer.paired = ok;
        if (ok) { toast(`Paired with ${peer.name}`); renderActionsPanel(); }
        else toast('Enter a pairing code');
      };
      row.appendChild(input);
      row.appendChild(btn);
      sec.appendChild(row);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'ap-actions';
      for (const a of peer.list) {
        const btn = document.createElement('button');
        btn.className = 'ap-btn' + (a.danger ? ' danger' : '');
        btn.innerHTML = `<span class="ico">${a.danger ? '⚠' : '▶'}</span><span>${escapeHtml(a.label || a.id)}</span><span class="run-state"></span>`;
        btn.onclick = () => runRemoteAction(peer, a, btn);
        wrap.appendChild(btn);
      }
      sec.appendChild(wrap);
    }
    body.appendChild(sec);
  }
}

async function runRemoteAction(peer, action, btn) {
  if (action.confirm) {
    const ok = confirm(`Run "${action.label || action.id}" on ${peer.name}?`);
    if (!ok) return;
  }
  const stateEl = btn.querySelector('.run-state');
  stateEl.textContent = 'running…';
  btn.setAttribute('disabled', '');
  const reqId = await window.api.runRemote(peer.peerId, action.id);
  if (reqId) runStates[reqId] = { peerId: peer.peerId, actionId: action.id, label: action.label || action.id, btn };
  else { stateEl.textContent = 'failed'; btn.removeAttribute('disabled'); }
}

function showActionResult(r) {
  const meta = runStates[r.reqId] || {};
  const el = $('actionsResult');
  el.className = 'actions-result ' + (r.ok ? 'ok' : 'err');
  const codePart = r.code === null || r.code === undefined ? '' : ` · exit ${r.code}`;
  const out = (r.output || r.error || '(no output)').toString();
  el.innerHTML = `<div class="ar-head">${r.ok ? '✓' : '✕'} ${escapeHtml(meta.label || r.id)}${escapeHtml(codePart)}</div><pre></pre>`;
  el.querySelector('pre').textContent = out;
  el.classList.remove('hidden');
  // reset the button
  if (meta.btn) {
    const stateEl = meta.btn.querySelector('.run-state');
    if (stateEl) stateEl.textContent = r.ok ? 'done' : 'error';
    meta.btn.removeAttribute('disabled');
    setTimeout(() => { if (stateEl) stateEl.textContent = ''; }, 3000);
  }
  toast(r.ok ? `✓ ${meta.label || r.id}` : `✕ ${meta.label || r.id} failed`);
  delete runStates[r.reqId];
}

function applyPeerActions(pa) {
  const i = peerActionsState.findIndex((p) => p.peerId === pa.peerId);
  if (!pa.list || !pa.list.length) {
    if (i >= 0) peerActionsState.splice(i, 1); // peer gone / disabled
  } else {
    const existing = i >= 0 ? peerActionsState[i] : {};
    const entry = { peerId: pa.peerId, name: pa.name || existing.name, enabled: pa.enabled, list: pa.list, paired: existing.paired || false };
    if (i >= 0) peerActionsState[i] = entry; else peerActionsState.push(entry);
  }
  updateActionsDot();
  if (!$('actionsModal').classList.contains('hidden')) renderActionsPanel();
}

// ---------- status ----------
function applyStatus(s) {
  if (s.connected) {
    statusPill.className = 'status-pill connected';
    const who = s.peers && s.peers.length ? s.peers.join(', ') : 'peer';
    statusText.textContent = s.count > 1 ? `${s.count} machines` : `Connected · ${who}`;
  } else {
    statusPill.className = 'status-pill searching';
    statusText.textContent = 'Searching…';
  }
}

// ---------- IPC wiring ----------
window.api.onHistory((h) => { history = h; render(); });
window.api.onStatus(applyStatus);
window.api.onPeerActions(applyPeerActions);
window.api.onRunResult(showActionResult);
window.api.onIncoming((note) => {
  const from = (note.origin && note.origin.name) || 'your other machine';
  toast(`New from ${from}`);
  // highlight the fresh card briefly
  requestAnimationFrame(() => {
    const el = feed.querySelector(`.card[data-id="${note.id}"]`);
    if (el) { el.classList.add('fresh'); setTimeout(() => el.classList.remove('fresh'), 2500); }
  });
});

(async function init() {
  const data = await window.api.init();
  self = data.self;
  localIPs = data.localIPs || [];
  history = data.history || [];
  $('selfName').textContent = self.name;
  applyStatus(data.status);
  render();
  editor.focus();
  peerActionsState = (await window.api.actionsPeers()) || [];
  updateActionsDot();
})();
