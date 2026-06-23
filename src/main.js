'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { Sync, newId } = require('./sync');
const { Actions } = require('./actions');
const { TerminalManager } = require('./terminal');
const { startCliServer } = require('./cliserver');
const { setupUpdater } = require('./updater');

const CLI_PORT = 50780; // localhost-only control API for the `send-it` CLI

let win = null;
let sync = null;
let tray = null;
let actions = null;
let terminal = null;
let cliServer = null;
let updater = null;

// Recent connection-log lines, shown in Help → Diagnostics + appended to
// connection.log in the app's data dir for after-the-fact debugging.
const logBuffer = [];
function pushLog(m) {
  const line = `${new Date().toISOString()}  ${m}`;
  logBuffer.push(line);
  if (logBuffer.length > 250) logBuffer.shift();
  try { fs.appendFileSync(path.join(userDir, 'connection.log'), line + '\n'); } catch (_) {}
  send('log', m);
}

// Keep a single running instance — relaunching just re-focuses the window.
// This is also the safety net for Linux desktops with no system tray.
// SENDIT_ALLOW_MULTI=1 is a dev-only escape hatch (run a test build alongside
// an installed copy); it has no effect in normal use.
const gotLock = process.env.SENDIT_ALLOW_MULTI === '1' || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

const userDir = app.getPath('userData');
const historyFile = path.join(userDir, 'history.json');
const configFile = path.join(userDir, 'config.json');
const actionsFile = path.join(userDir, 'actions.json');
const actionsLog = path.join(userDir, 'actions.log');

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
  // Trusted Actions: this machine's pairing code (others must present it to run
  // our actions) + the codes we've stored for peers we control.
  let changed = false;
  if (!cfg.pairingToken) { cfg.pairingToken = makePairingCode(); changed = true; }
  if (!cfg.peerTokens || typeof cfg.peerTokens !== 'object') { cfg.peerTokens = {}; changed = true; }
  if (!cfg.cliToken) { cfg.cliToken = require('crypto').randomBytes(16).toString('hex'); changed = true; }
  // Remote Terminal: a SEPARATE opt-in from Trusted Actions, OFF by default.
  // When on, paired peers can open a real shell on this machine.
  if (typeof cfg.terminalEnabled !== 'boolean') { cfg.terminalEnabled = false; changed = true; }
  // macOS: show a Dock icon too, or stay menu-bar-only (default). Off keeps the
  // current pure-tray behavior.
  if (typeof cfg.showDock !== 'boolean') { cfg.showDock = false; changed = true; }
  if (changed) saveJSON(configFile, cfg);
  return cfg;
}

// Tell the `send-it` CLI how to reach the local control API. 0600 so only this
// user can read the token.
function writeCliInfo(port, token, name) {
  const file = path.join(os.homedir(), '.send-it-cli.json');
  try { fs.writeFileSync(file, JSON.stringify({ port, token, name }), { mode: 0o600 }); } catch (_) {}
}

// Short, human-typeable pairing code (e.g. "GHOST-4F2A-9C7E").
function makePairingCode() {
  const hex = require('crypto').randomBytes(4).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
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
    // macOS gets its icon from the .app bundle; Linux needs it set explicitly
    // or the window/taskbar shows a broken-icon "X".
    ...(process.platform === 'linux'
      ? { icon: path.join(__dirname, '..', 'build', 'icon.png') }
      : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Right-click context menu: Copy on any selected text (e.g. grabbing a line
  // out of history), full Cut/Copy/Paste/Select All in editable fields.
  win.webContents.on('context-menu', (_e, params) => {
    const { isEditable, selectionText, editFlags } = params;
    const tpl = [];
    if (isEditable) {
      tpl.push(
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (selectionText && selectionText.trim()) {
      tpl.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    }
    if (tpl.length) Menu.buildFromTemplate(tpl).popup({ window: win });
  });

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

// macOS Dock icon visibility. Hiding it keeps Send It a pure menu-bar app;
// showing it adds a Dock icon (and ⌘-Tab entry). No-op off macOS.
function applyDockVisibility(show) {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (show) app.dock.show(); else app.dock.hide();
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

  // Trusted Actions: load this machine's registry and bridge it to Sync.
  actions = new Actions({ file: actionsFile, logFile: actionsLog });
  sync.setActionsProvider({
    publicState: () => ({ enabled: actions.enabled, list: actions.publicList() }),
    run: (id, source, cb) => actions.run(id, source, cb),
    pairingToken: () => getConfig().pairingToken, // validate inbound run requests
    peerToken: (peerId) => (getConfig().peerTokens || {})[peerId] || '', // sign outbound
  });

  // Remote Terminal: load the PTY manager and bridge it to Sync. enabled() is
  // true ONLY when the user opted in AND the native module actually loaded, so
  // peers never see a shell we can't honor. Pairing uses the same code as
  // Trusted Actions (validated in sync._handleTermOpen).
  terminal = new TerminalManager();
  sync.setTerminalProvider({
    enabled: () => getConfig().terminalEnabled && terminal.available(),
    pairingToken: () => getConfig().pairingToken,
    open: (opts) => terminal.open(opts),
    write: (sid, data) => terminal.write(sid, data),
    resize: (sid, cols, rows) => terminal.resize(sid, cols, rows),
    close: (sid) => terminal.close(sid),
    has: (sid) => terminal.has(sid),
    closePeer: (peerId) => terminal.closePeer(peerId),
  });

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
  sync.on('peer-actions', (pa) => send('peer-actions', pa));
  sync.on('run-result', (r) => send('run-result', r));
  // Remote Terminal stream events → renderer.
  sync.on('peer-terminal', (pt) => send('peer-terminal', pt));
  sync.on('term-opened', (t) => send('term-opened', t));
  sync.on('term-data', (t) => send('term-data', t));
  sync.on('term-exit', (t) => send('term-exit', t));
  sync.on('log', pushLog);

  pushLog(`starting — ${cfg.name} (${String(cfg.id).slice(0, 8)}) on ports ws ${50778}/disc ${50777}; manual peers: ${cfg.manualPeers.join(', ') || 'none'}`);
  sync.start();

  // Phase 3: local CLI control API (127.0.0.1 only).
  cliServer = startCliServer({ port: CLI_PORT, token: cfg.cliToken, sync, onLog: (m) => send('log', m) });
  writeCliInfo(CLI_PORT, cfg.cliToken, cfg.name);
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

// Toggle the macOS Dock icon (Settings → Device).
ipcMain.handle('set-dock-visible', (_e, show) => {
  const cfg = getConfig();
  cfg.showDock = !!show;
  saveJSON(configFile, cfg);
  applyDockVisibility(cfg.showDock);
  return cfg.showDock;
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

// ---- Trusted Actions IPC ----

// This machine's own action config + pairing code (for Settings).
ipcMain.handle('actions-self', () => {
  const cfg = getConfig();
  return {
    enabled: actions ? actions.enabled : false,
    pairingCode: cfg.pairingToken,
    count: actions ? actions.actions.size : 0,
    file: actionsFile,
  };
});

// Peer action lists + which peers we've paired with (have a token for).
ipcMain.handle('actions-peers', () => {
  const cfg = getConfig();
  const list = sync ? sync.peerActionsSnapshot() : [];
  return list.map((p) => ({ ...p, paired: !!(cfg.peerTokens || {})[p.peerId] }));
});

ipcMain.handle('set-actions-enabled', (_e, on) => {
  if (actions) actions.setEnabled(!!on);
  if (sync) sync.broadcastActions(); // tell peers our list/enabled changed
  return actions ? actions.enabled : false;
});

ipcMain.handle('reload-actions', () => {
  if (actions) actions.load();
  if (sync) sync.broadcastActions();
  return actions ? { enabled: actions.enabled, count: actions.actions.size } : null;
});

// Full action defs (incl. command) for the in-app editor — local machine only.
ipcMain.handle('actions-full', () => (actions ? [...actions.actions.values()] : []));

ipcMain.handle('actions-save', (_e, def) => {
  if (!actions) return false;
  const ok = actions.upsert(def);
  if (ok && sync) sync.broadcastActions();
  return ok;
});

ipcMain.handle('actions-delete', (_e, id) => {
  if (!actions) return false;
  const ok = actions.remove(id);
  if (ok && sync) sync.broadcastActions();
  return ok;
});

ipcMain.handle('open-actions-file', () => {
  // Make sure the file exists so the editor opens something.
  if (actions && actions.actions.size === 0 && !fs.existsSync(actionsFile)) actions.persist();
  shell.openPath(actionsFile);
  return actionsFile;
});

// Store a peer's pairing code locally so we can trigger its actions.
ipcMain.handle('pair-peer', (_e, peerId, code) => {
  const cfg = getConfig();
  cfg.peerTokens = cfg.peerTokens || {};
  const c = String(code || '').trim().toUpperCase();
  if (c) cfg.peerTokens[peerId] = c; else delete cfg.peerTokens[peerId];
  saveJSON(configFile, cfg);
  return !!c;
});

// Ask a connected peer to run one of its actions.
ipcMain.handle('run-remote', (_e, peerId, actionId) => {
  if (!sync) return null;
  return sync.sendRun(peerId, actionId);
});

// ---- Remote Terminal IPC ----

// This machine's terminal switch + whether the native PTY is usable here.
ipcMain.handle('terminal-self', () => {
  const cfg = getConfig();
  return {
    enabled: !!cfg.terminalEnabled,
    available: terminal ? terminal.available() : false,
    reason: terminal ? terminal.unavailableReason() : 'not initialized',
    pairingCode: cfg.pairingToken,
  };
});

// Toggle exposing a shell on THIS machine, then re-advertise to peers.
ipcMain.handle('set-terminal-enabled', (_e, on) => {
  const cfg = getConfig();
  cfg.terminalEnabled = !!on;
  saveJSON(configFile, cfg);
  if (sync) sync.broadcastTerminalState();
  return cfg.terminalEnabled;
});

// Connected peers that currently expose a shell + whether we've paired with them.
ipcMain.handle('terminal-peers', () => {
  const cfg = getConfig();
  const list = sync ? sync.peerTerminalSnapshot() : [];
  return list.map((p) => ({ ...p, paired: !!(cfg.peerTokens || {})[p.peerId] }));
});

// Open a shell on a peer. Returns a reqId; the session id arrives via term-opened.
ipcMain.handle('term-open', (_e, peerId, cols, rows) => {
  if (!sync) return null;
  return sync.sendTermOpen(peerId, cols, rows);
});

ipcMain.handle('term-input', (_e, peerId, sid, data) => {
  if (sync) sync.sendTermData(peerId, sid, data);
});

ipcMain.handle('term-resize', (_e, peerId, sid, cols, rows) => {
  if (sync) sync.sendTermResize(peerId, sid, cols, rows);
});

ipcMain.handle('term-close', (_e, peerId, sid) => {
  if (sync) sync.sendTermClose(peerId, sid);
});

// ---- Diagnostics / Help ----

function probeTcp(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    const s = net.connect({ host, port, timeout });
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

ipcMain.handle('run-diagnostics', async () => {
  const cfg = getConfig();
  const d = sync ? sync.diagnostics() : { listening: false, discoveryBound: false, connected: false, peers: [], manualPeers: [], wsPort: 50778, discoveryPort: 50777 };
  const ips = localIPs();
  const checks = [];

  checks.push({ ok: ips.length > 0, label: 'On a local network',
    detail: ips.length ? ips.join(', ') : 'no network interface found',
    hint: ips.length ? '' : 'Connect this machine to Wi-Fi/Ethernet.' });

  checks.push({ ok: !!d.listening, label: `Listening for connections (TCP ${d.wsPort})`,
    detail: d.listening ? 'ok' : 'not listening',
    hint: d.listening ? '' : 'Port may be in use by another app — quit duplicates and restart Send It.' });

  checks.push({ ok: !!d.discoveryBound, label: `Discovery active (UDP ${d.discoveryPort})`,
    detail: d.discoveryBound ? 'ok' : 'not bound',
    hint: d.discoveryBound ? '' : 'Restart Send It; another process may hold the discovery port.' });

  // Probe each manually-paired peer.
  for (const ip of d.manualPeers) {
    const reachable = await probeTcp(ip, d.wsPort, 3000);
    const macHint = process.platform === 'darwin'
      ? ' If a terminal can reach it (nc succeeds) but this check fails, macOS is blocking Local Network access — enable Send It under System Settings → Privacy & Security → Local Network.'
      : '';
    checks.push({
      ok: reachable,
      label: `Reach ${ip}:${d.wsPort}`,
      detail: reachable ? 'reachable' : 'NOT reachable',
      hint: reachable ? '' : `Send It may not be running on ${ip}, that machine may be asleep/off, or a firewall is blocking it (allow ${d.wsPort}/tcp + ${d.discoveryPort}/udp).${macHint}`,
    });
  }

  checks.push({ ok: !!d.connected, label: 'Connected to another machine',
    detail: d.connected ? d.peers.join(', ') : 'no peer connected',
    hint: d.connected ? '' : (d.manualPeers.length
      ? 'See the reachability check above for the likely cause.'
      : 'Open Send It on your other machine on the same network. If auto-discovery fails, add its IP under Settings → Connect by IP.') });

  if (process.platform === 'darwin') {
    checks.push({ ok: true, info: true, label: 'macOS: Local Network permission',
      detail: 'required',
      hint: 'If this Mac can\'t reach others, check System Settings → Privacy & Security → Local Network → Send It is ON.' });
  }

  return {
    self: { name: cfg.name, id: cfg.id, platform: process.platform, version: app.getVersion() },
    localIPs: ips,
    ports: { ws: d.wsPort, discovery: d.discoveryPort },
    connected: d.connected,
    peers: d.peers,
    manualPeers: d.manualPeers,
    checks,
  };
});

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('get-logs', () => logBuffer.slice());
ipcMain.handle('reconnect', () => { if (sync) sync.reconnect(); return true; });
ipcMain.handle('open-local-network-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
  }
  return process.platform === 'darwin';
});

// ---- Updates (Phase 4) ----
ipcMain.handle('check-updates', () => (updater ? updater.check() : { state: 'unsupported' }));
ipcMain.handle('download-update', () => (updater ? updater.download() : false));
ipcMain.handle('install-update', () => { if (updater) updater.install(); });
ipcMain.handle('update-info', () => ({
  available: !!(updater && updater.available),
  canAutoInstall: !!(updater && updater.canAutoInstall),
  releasesUrl: updater ? updater.releasesUrl : '',
}));

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
  // macOS: menu-bar app, with an optional Dock icon (user preference).
  applyDockVisibility(getConfig().showDock);

  startSync();
  createTray();
  createWindow();

  // Re-apply the saved launch-at-login preference each start.
  const cfg = getConfig();
  if (cfg.openAtLogin) setLoginItem(true);

  // Updates: wire event handlers only. We do NOT auto-check on launch — update
  // checks happen only when the user clicks "Check for updates" in Help, so a
  // missing release/metadata never produces noise or affects connectivity.
  updater = setupUpdater(send);

  app.on('activate', () => showWindow());
});

// Don't quit when the window is hidden — the app lives in the tray.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (terminal) { try { terminal.closeAll(); } catch (_) {} }
  if (sync) sync.stop();
  if (cliServer) { try { cliServer.close(); } catch (_) {} }
});
