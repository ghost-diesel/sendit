'use strict';

// In-app updating (Phase 4) via electron-updater + GitHub Releases.
//
// Linux (AppImage): full auto-update — download the new release and relaunch
// into it. This is the primary target (updating Homebase hands-free).
//
// macOS: auto-install needs a Developer ID signature, which this ad-hoc-signed
// build doesn't have, so we degrade gracefully — detect the newer version and
// offer to open the Releases download page instead of swapping in place.

const { app, shell } = require('electron');

const RELEASES_URL = 'https://github.com/ghost-diesel/sendit/releases/latest';
const canAutoInstall = process.platform === 'linux'; // AppImage updates in place

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

function setupUpdater(send) {
  // Updates only work in a packaged build with a publish provider.
  const available = !!autoUpdater && app.isPackaged;

  if (available) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false; // never act unless the user asks

    autoUpdater.on('update-available', (info) => {
      send('update-status', { state: 'available', version: info.version, canAutoInstall });
    });
    autoUpdater.on('update-not-available', () => send('update-status', { state: 'current' }));
    autoUpdater.on('error', (err) => send('update-status', { state: 'error', message: String(err && err.message || err) }));
    autoUpdater.on('download-progress', (p) => send('update-status', { state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => send('update-status', { state: 'downloaded', version: info.version }));
  }

  return {
    available,
    releasesUrl: RELEASES_URL,
    canAutoInstall,

    async check() {
      if (!available) return { state: 'unsupported' };
      try {
        await autoUpdater.checkForUpdates();
        return { state: 'checking' };
      } catch (err) {
        send('update-status', { state: 'error', message: String(err && err.message || err) });
        return { state: 'error' };
      }
    },

    async download() {
      if (!available) return false;
      if (!canAutoInstall) { shell.openExternal(RELEASES_URL); return 'external'; }
      try { await autoUpdater.downloadUpdate(); return true; } catch (_) { return false; }
    },

    install() {
      if (available && canAutoInstall) autoUpdater.quitAndInstall();
      else shell.openExternal(RELEASES_URL);
    },

    openReleases() { shell.openExternal(RELEASES_URL); },
  };
}

module.exports = { setupUpdater };
