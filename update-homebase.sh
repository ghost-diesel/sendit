#!/usr/bin/env bash
#
# Update Send It on THIS machine to the latest GitHub release.
#
# Works with a PRIVATE repo via the GitHub CLI. One-time setup:
#   sudo pacman -S github-cli   # (Debian/Ubuntu: sudo apt install gh)
#   gh auth login               # sign in once
#
# Handles the recurring gotcha: Send It lives in the tray, so it must be fully
# quit (not just window-closed) before the new build can take over. The swap is
# detached (setsid), so this is even safe to run from inside Send It's own
# remote terminal — the new app survives this shell going away.
set -euo pipefail

REPO="ghost-diesel/sendit"
APP="$HOME/Documents/sendit/SendIt.AppImage"   # stable path, so it never changes

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI not found. Install + sign in once:"
  echo "  Arch:    sudo pacman -S github-cli && gh auth login"
  echo "  Debian:  sudo apt install gh && gh auth login"
  exit 1
}

echo "→ Checking latest release…"
TAG=$(gh release view --repo "$REPO" --json tagName -q .tagName)
echo "  latest is $TAG"

echo "→ Downloading the AppImage…"
TMP=$(mktemp -d)
gh release download "$TAG" --repo "$REPO" --pattern '*.AppImage' --dir "$TMP" --clobber
NEW=$(ls "$TMP"/*.AppImage | head -1)
chmod +x "$NEW"

echo "→ Quitting the old version, installing $TAG, relaunching…"
# Detach the swap so it survives this shell being killed along with Send It
# (which happens if you run this from Send It's own terminal).
setsid bash -c "
  pkill -f 'SendIt.AppImage' 2>/dev/null || true
  pkill -f 'Send It'        2>/dev/null || true
  sleep 2
  mv -f '$NEW' '$APP'
  rm -rf '$TMP'
  '$APP' >/dev/null 2>&1 &
" >/dev/null 2>&1 < /dev/null &

echo "✓ Updating to $TAG — Send It will relaunch in a few seconds."
echo "  (Verify in Settings → Updates → Version once it's back.)"
