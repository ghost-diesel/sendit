#!/usr/bin/env bash
#
# One-time setup for the Linux machine.
# Installs dependencies and builds a single clickable "Send It" AppImage.
# After this finishes, you never need the terminal again — just double-click
# the .AppImage in the dist/ folder (drag it to your desktop or app menu).
#
set -e

cd "$(dirname "$0")"

echo "✦ Send It — building the Linux app..."
echo

# Need Node.js. Most distros have it; if not, install it first.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Install it first, e.g.:"
  echo "  Debian/Ubuntu:  sudo apt install nodejs npm"
  echo "  Fedora:         sudo dnf install nodejs npm"
  echo "  Arch:           sudo pacman -S nodejs npm"
  exit 1
fi

echo "→ Installing dependencies (one time)..."
npm install --cache "$PWD/.npm-cache"

echo
echo "→ Building the AppImage..."
npm run dist:linux

echo
echo "✓ Done!"
echo
APPIMAGE=$(ls -1 dist/*.AppImage 2>/dev/null | head -1 || true)
if [ -n "$APPIMAGE" ]; then
  chmod +x "$APPIMAGE"
  echo "Your app is here:"
  echo "  $PWD/$APPIMAGE"
  echo
  echo "Double-click it to run. Drag it to your desktop or app launcher to pin it."
  echo "Open Send It here AND on your Mac, and they'll find each other automatically."
else
  echo "Build finished — check the dist/ folder for the .AppImage."
fi
