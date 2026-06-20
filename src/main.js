'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Sync, newId } = require('./sync');

let win = null;
let sync = null;
let tray = null;

// Keep a single running instance — relaunching just re-focuses the window.
// This is also the safety net for Linux desktops with no system tray.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

const userDir = app.getPath('userData');
const historyFile = path.join(userDir, 'history.json');
const configFile = path.join(userDir, 'config.json');

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (_) {}
}

function getConfig() {
  let cfg = loadJSON(configFile, null);
  if (!cfg || !cfg.id) {
    cfg = { id: newId(), name: os.hostname().replace(/\.local$/, ''), manualPeers: [] };
    saveJSON(configFile, cfg);
  }
  if (!Array.isArray(cfg.manualPeers)) cfg.manualPeers = [];
  return cfg;
}

// This machine's LAN IPv4 address(es) — shown in settings so the user knows
// what to type on the other machine if they use manual pairing.
function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// ---- Received files folder ----
// Everything received from a peer is auto-saved to a predictable local folder
// (~/Downloads/Send It) so images/files are easy to find. All local, no cloud.

function receivedDir() {
  const dir = path.join(app.getPath('downloads'), 'Send It');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}

// Pick a non-colliding path in dir for the given filename (adds " (n)").
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || 'file';
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

// Write a received image/file note's bytes to the received folder.
// Returns the absolute path, or null on failure.
function saveReceived(note) {
  try {
    const dir = receivedDir();
    let name = note.name;
    if (!name) {
      const stamp = new Date(note.createdAt || Date.now())
        .toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = note.type === 'image' ? extFromMime(note.mime) : 'bin';
      name = `${note.type === 'image' ? 'image' : 'file'}-${stamp}.${ext}`;
    }
    const target = uniquePath(dir, name);
    const b64 = (note.data || '').split(',').pop();
    fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    return target;
  } catch (_) {
    return null;
  }
}

// Auto-save any received (not-ours) image/file notes that aren't on disk yet.
// Mutates notes in place to record their local path. Returns true if anything
// changed (so the caller can re-persist + refresh the UI).
function processReceivedFiles(history, selfId) {
  let changed = false;
  for (const note of history) {
    if ((note.type !== 'image' && note.type !== 'file') || !note.data || note.localPath) continue;
    if (note.origin && note.origin.id === selfId) continue; // skip our own
    const p = saveReceived(note);
    if (p) { note.localPath = p; changed = true; }
  }
  return changed;
}

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    title: 'Send It',
    backgroundColor: '#0b0c10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window hides it to the tray instead of quitting.
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ---- Tray (menu bar) ----

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    win.show();
    win.focus();
  }
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  else showWindow();
}

function createTray() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'build', 'trayTemplate.png')
  );
  icon.setTemplateImage(true); // macOS auto-recolors for light/dark menu bar
  tray = new Tray(icon);
  tray.setToolTip('Send It');
  // On Windows/Linux a left click is expected to toggle the window.
  if (process.platform !== 'darwin') {
    tray.on('click', toggleWindow);
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const cfg = getConfig();
  const s = sync ? sync.statusSnapshot() : { connected: false, peers: [] };
  const statusLabel = s.connected
    ? `● Connected${s.peers && s.peers.length ? ' · ' + s.peers.join(', ') : ''}`
    : '○ Searching for your other machine…';

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Show Send It', click: showWindow },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: !!cfg.openAtLogin,
      click: (item) => setLoginItem(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit Send It', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---- Launch at login ----

function setLoginItem(enabled) {
  const cfg = getConfig();
  cfg.openAtLogin = enabled;
  saveJSON(configFile, cfg);
  if (process.platform === 'linux') {
    setLinuxAutostart(enabled);
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  }
  updateTrayMenu();
}

// Linux has no setLoginItemSettings — use an XDG autostart .desktop file.
function setLinuxAutostart(enabled) {
  const dir = path.join(os.homedir(), '.config', 'autostart');
  const file = path.join(dir, 'send-it.desktop');
  if (enabled) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(
        file,
        '[Desktop Entry]\n' +
          'Type=Application\n' +
          'Name=Send It\n' +
          `Exec="${exec}"\n` +
          'Icon=send-it\n' +
          'Comment=LAN notepad sync\n' +
          'X-GNOME-Autostart-enabled=true\n'
      );
    } catch (_) {}
  } else {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function startSync() {
  const cfg = getConfig();
  const history = loadJSON(historyFile, []);

  sync = new Sync({ id: cfg.id, name: cfg.name, manualPeers: cfg.manualPeers });
  sync.setHistory(history);

  // Catch up any received files already in history (e.g. received by an older
  // version, or before this machine had the feature) so they get a local copy.
  if (processReceivedFiles(history, cfg.id)) saveJSON(historyFile, history);

  sync.on('history-changed', (h) => {
    processReceivedFiles(h, cfg.id); // auto-save received images/files locally
    saveJSON(historyFile, h);
    send('history', h);
  });
  sync.on('status', (s) => { send('status', s); updateTrayMenu(); });
  sync.on('incoming', (note) => send('incoming', note));
  sync.on('log', (m) => send('log', m));

  sync.start();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ---- IPC: renderer -> main ----

ipcMain.handle('init', () => {
  const cfg = getConfig();
  return {
    history: sync ? sync.history : [],
    status: sync ? sync.statusSnapshot() : { connected: false, count: 0, peers: [], selfName: cfg.name },
    self: cfg,
    localIPs: localIPs(),
  };
});

ipcMain.handle('set-manual-peers', (_e, list) => {
  const cfg = getConfig();
  const arr = (Array.isArray(list) ? list : String(list || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  cfg.manualPeers = arr;
  saveJSON(configFile, cfg);
  if (sync) sync.setManualPeers(arr);
  return arr;
});

ipcMain.handle('publish-note', (_e, note) => {
  if (sync) sync.publishNote(note);
});

ipcMain.handle('delete-note', (_e, id) => {
  if (sync) sync.deleteNote(id);
});

ipcMain.handle('clear-all', () => {
  if (sync) sync.clearAll();
});

ipcMain.handle('set-name', (_e, name) => {
  const cfg = getConfig();
  cfg.name = (name || '').trim() || os.hostname();
  saveJSON(configFile, cfg);
  if (sync) sync.name = cfg.name;
  return cfg.name;
});

ipcMain.handle('copy-text', (_e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('copy-image', (_e, dataUrl) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(img);
    return true;
  } catch (_) {
    return false;
  }
});

// Read whatever is on the clipboard (used by the "paste clipboard" button).
ipcMain.handle('read-clipboard', () => {
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    return { type: 'image', dataUrl: img.toDataURL() };
  }
  const text = clipboard.readText();
  return { type: 'text', text };
});

// Save a file/image note to disk via a native dialog.
ipcMain.handle('save-note-file', async (_e, note) => {
  const defaultName = note.name || (note.type === 'image' ? 'image.png' : 'file.bin');
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), defaultName),
  });
  if (res.canceled || !res.filePath) return false;
  try {
    const b64 = (note.data || '').split(',').pop();
    fs.writeFileSync(res.filePath, Buffer.from(b64, 'base64'));
    return res.filePath;
  } catch (_) {
    return false;
  }
});

// Open the received-files folder in Finder/file manager.
ipcMain.handle('open-received-folder', () => {
  const dir = receivedDir();
  shell.openPath(dir);
  return dir;
});

// Reveal a received file in Finder/file manager.
ipcMain.handle('show-in-folder', (_e, p) => {
  if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return true; }
  return false;
});

// Open a received file with the OS default app.
ipcMain.handle('open-file', async (_e, p) => {
  if (p && fs.existsSync(p)) {
    const err = await shell.openPath(p); // '' on success
    return err === '';
  }
  return false;
});

app.whenReady().then(() => {
  // Pure menu-bar app on macOS — no dock icon.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  startSync();
  createTray();
  createWindow();

  // Re-apply the saved launch-at-login preference each start.
  const cfg = getConfig();
  if (cfg.openAtLogin) setLoginItem(true);

  app.on('activate', () => showWindow());
});

// Don't quit when the window is hidden — the app lives in the tray.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (sync) sync.stop();
});
