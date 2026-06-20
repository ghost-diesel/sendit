'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  publishNote: (note) => ipcRenderer.invoke('publish-note', note),
  deleteNote: (id) => ipcRenderer.invoke('delete-note', id),
  clearAll: () => ipcRenderer.invoke('clear-all'),
  setName: (name) => ipcRenderer.invoke('set-name', name),
  setManualPeers: (list) => ipcRenderer.invoke('set-manual-peers', list),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  saveNoteFile: (note) => ipcRenderer.invoke('save-note-file', note),
  openReceivedFolder: () => ipcRenderer.invoke('open-received-folder'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  openFile: (p) => ipcRenderer.invoke('open-file', p),

  // Trusted Actions
  actionsSelf: () => ipcRenderer.invoke('actions-self'),
  actionsPeers: () => ipcRenderer.invoke('actions-peers'),
  setActionsEnabled: (on) => ipcRenderer.invoke('set-actions-enabled', on),
  reloadActions: () => ipcRenderer.invoke('reload-actions'),
  openActionsFile: () => ipcRenderer.invoke('open-actions-file'),
  actionsFull: () => ipcRenderer.invoke('actions-full'),
  actionsSave: (def) => ipcRenderer.invoke('actions-save', def),
  actionsDelete: (id) => ipcRenderer.invoke('actions-delete', id),
  pairPeer: (peerId, code) => ipcRenderer.invoke('pair-peer', peerId, code),
  runRemote: (peerId, actionId) => ipcRenderer.invoke('run-remote', peerId, actionId),

  // Diagnostics / help
  runDiagnostics: () => ipcRenderer.invoke('run-diagnostics'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  reconnect: () => ipcRenderer.invoke('reconnect'),

  // Updates
  updateInfo: () => ipcRenderer.invoke('update-info'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),

  onHistory: (cb) => ipcRenderer.on('history', (_e, h) => cb(h)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onIncoming: (cb) => ipcRenderer.on('incoming', (_e, n) => cb(n)),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onPeerActions: (cb) => ipcRenderer.on('peer-actions', (_e, pa) => cb(pa)),
  onRunResult: (cb) => ipcRenderer.on('run-result', (_e, r) => cb(r)),
});
