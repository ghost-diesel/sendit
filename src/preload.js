'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  publishNote: (note) => ipcRenderer.invoke('publish-note', note),
  deleteNote: (id) => ipcRenderer.invoke('delete-note', id),
  clearAll: () => ipcRenderer.invoke('clear-all'),
  setName: (name) => ipcRenderer.invoke('set-name', name),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  saveNoteFile: (note) => ipcRenderer.invoke('save-note-file', note),

  onHistory: (cb) => ipcRenderer.on('history', (_e, h) => cb(h)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onIncoming: (cb) => ipcRenderer.on('incoming', (_e, n) => cb(n)),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
});
