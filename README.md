# Send It ✦

A beautiful, dead-simple notepad that **syncs instantly between your machines over the local network**.
No cloud. No accounts. No logins. No terminal once it's set up. Your notes never leave your home network.

Type or paste something on one machine → hit **⌘/Ctrl + Enter** → it shows up on the other machine instantly.
Text, code, screenshots, and files all work.

![Send It](build/icon.png)

---

## How it works (the 10-second version)

Both machines run the same little app. When they're on the same network (yours always are — same
home base, same router), they **find each other automatically** and keep their note history in sync.
There is nothing to configure. Open it on both → they connect. That's it.

- 🔒 **Private** — notes go straight from one machine to the other over your LAN. Never touches the internet.
- ⚡ **Instant** — send on one, it's on the other before you can switch the KVM.
- 🧠 **History** — everything you send stays in a synced list you can copy from with one click.
- 🖼️ **Anything** — plain text, code (monospace, no autocorrect mangling), pasted images, dragged files.
- 🔍 **Click to preview** — received images open full-size in an in-app lightbox; received files auto-save to `~/Downloads/Send It/`.

---

## Setup

### Mac (already built for you)

1. Open the `dist` folder.
2. Open **`Send It-1.0.0-arm64.dmg`** and drag **Send It** into Applications.
3. First launch only: if macOS says it's from an unidentified developer, **right-click the app → Open → Open**.
   (After that, it's a normal click-the-icon app forever.)

### Linux — just download it (no building)

1. Grab the latest **`.AppImage`** from the [**Releases page**](https://github.com/ghost-diesel/sendit/releases/latest).
2. Right-click it → **Properties → Permissions → "Allow executing as program"** (or `chmod +x` it).
3. **Double-click** to run. No install, no terminal. Drag it to your desktop or app launcher to pin it.

> **Build it yourself instead?** Clone the repo and run `./build-linux.sh` once — it installs deps and
> produces the AppImage in `dist/`. Every tagged release is also built automatically by GitHub Actions
> (see `.github/workflows/release.yml`).

---

## Lives in your menu bar

Send It runs as a **menu-bar app** — look for the little paper-plane icon up top (macOS) or in your
system tray (Linux). Click it for a menu:

- **Show Send It** — pop the window open.
- **Launch at login** — tick this once and it starts automatically every time you boot. Set it on both machines and you never have to think about it again.
- **Quit Send It**.

On macOS there's **no dock icon** — it's a pure menu-bar app. Closing the window (red button) just tucks
it back into the menu bar; it keeps running and syncing. Use **Quit** in the menu to fully exit.

> Linux note: the tray icon shows in any desktop with a system tray (KDE, XFCE, Cinnamon, etc.). On
> **GNOME** you may need the "AppIndicator" extension for the tray icon to appear — but you're never
> stuck: just double-click the AppImage again and the window comes right back (it won't open a second copy).

## Using it

1. Open **Send It** on both machines (and tick **Launch at login** so they're always ready).
2. The pill in the top-right turns **green → "Connected"** when they find each other.
3. Type or paste into the big box, then **⌘/Ctrl + Enter** (or click **Send It**).
4. Switch machines — it's already there in **History**. Click **Copy** to drop it on your clipboard.

**Tips**
- **Paste clipboard** button grabs whatever's on your clipboard (text or an image) without leaving the app.
- **Code mode** checkbox forces monospace; otherwise it auto-detects code and renders it nicely.
- **Drag a file** anywhere onto the window to send it (up to 25 MB).
- Click the **gear** to rename a machine (e.g. "Mac Mini" / "Linux Box") so you know where notes came from.

**Images & received files**
- **Click any image** in history to open a full-size preview (lightbox). Press **Esc**, click the **✕**,
  or click outside the image to close. PNG, JPG, WebP, and GIF are supported.
- Anything you **receive** from the other machine is automatically saved to a predictable folder:
  **`~/Downloads/Send It/`** (same on Mac and Linux). Filenames get a counter if they'd collide.
- The **Received folder** button (top of History) opens that folder. Received images/files also have
  **Open** and **Show in folder** actions on their card.

**Trusted actions (coming soon — disabled)**
- Settings shows a disabled placeholder for a future feature: letting a paired machine trigger a small,
  fixed set of safe actions (e.g. "restart Homebase"). It is **off by design** and will **never** run
  arbitrary shell commands. Design notes: [`docs/TRUSTED_ACTIONS.md`](docs/TRUSTED_ACTIONS.md).

---

## If they don't connect

First: make sure both machines are on the **same network/router**, and that you're running the
**same version** on both (re-download the latest Linux AppImage / rebuild the Mac app after updating).

Discovery is a small **UDP broadcast** on port **50777**; the actual sync is a WebSocket on port
**50778**. If a firewall blocks those, they won't find each other.

- **Linux firewall (`ufw`)** — this is the most common culprit. Allow the two ports:
  ```bash
  sudo ufw allow 50777/udp
  sudo ufw allow 50778/tcp
  ```
  (Or temporarily `sudo ufw disable` just to confirm the firewall is the cause.)

- **Still stuck? Pair manually — bulletproof.** Open **Settings (gear)** on each machine; it shows
  *This machine's IP*. On **one** machine, type the **other** machine's IP into **"Connect by IP"** and
  hit Done. This skips discovery entirely and connects directly. You only need to do it on one side.

- Some corporate/guest networks block broadcast between devices — a normal home router does not. On
  those, use the manual IP option above.

---

## Under the hood

- **Electron** app, identical on macOS + Linux.
- **UDP broadcast beacon** (port 50777) for zero-config peer discovery — deliberately *not* mDNS, since
  the OS mDNS daemon (mDNSResponder / avahi) owns port 5353 and swallows inbound multicast, so a
  userland mDNS stack can't hear remote machines. A plain broadcast on our own port has no such issue.
- **WebSockets** (`ws`, port 50778) for a direct, full-duplex, peer-to-peer sync connection.
- Optional **manual IP pairing** for networks that filter broadcast traffic.
- History is stored locally as JSON in the app's data folder and capped at the last 300 items.
- No server, no telemetry, no external calls.

Built files live in `dist/`. Source is in `src/`. To rebuild the icon: `node build/generate-icon.js`.
