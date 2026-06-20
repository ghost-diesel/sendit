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
    const img = document.createElement('img');
    img.src = note.data;
    body.appendChild(img);
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
    const save = chipBtn('Save…');
    save.onclick = () => saveNote(note);
    actions.appendChild(copy);
    actions.appendChild(save);
  } else {
    const save = chipBtn('Save…');
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

async function saveNote(note) {
  const path = await window.api.saveNoteFile(note);
  if (path) toast('Saved');
}

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
})();
