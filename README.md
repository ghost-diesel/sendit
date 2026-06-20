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

---

## Setup

### Mac (already built for you)

1. Open the `dist` folder.
2. Open **`Send It-1.0.0-arm64.dmg`** and drag **Send It** into Applications.
3. First launch only: if macOS says it's from an unidentified developer, **right-click the app → Open → Open**.
   (After that, it's a normal click-the-icon app forever.)

### Linux (one command, one time)

Copy this whole `send it` folder to your Linux box, then run **once**:

```bash
cd "send it"
./build-linux.sh
```

That produces a single **`Send It-1.0.0.AppImage`** file in `dist/`. Double-click it to run — no install,
no terminal ever again. (You can drag it to your desktop or app launcher and pin it.)

> Don't want to build? You can also just run `npm install && npm start` in the folder, but the AppImage
> gives you the real click-an-icon experience.

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

---

## If they don't connect

They rely on local network discovery (mDNS/Bonjour, the same tech AirPlay and printers use).

- Make sure both machines are on the **same network/router**.
- **Linux firewall**: if you use `ufw`, allow mDNS and the app:
  ```bash
  sudo ufw allow 5353/udp
  ```
  (Send It uses an automatic high port for the actual sync; if you have a strict firewall, allow the
  app through, or temporarily disable the firewall to confirm that's the cause.)
- Corporate/guest networks sometimes block multicast — a normal home router does not.

---

## Under the hood

- **Electron** app, identical on macOS + Linux.
- **mDNS** (`bonjour-service`) for zero-config peer discovery on the LAN.
- **WebSockets** (`ws`) for a direct, full-duplex, peer-to-peer sync connection.
- History is stored locally as JSON in the app's data folder and capped at the last 300 items.
- No server, no telemetry, no external calls.

Built files live in `dist/`. Source is in `src/`. To rebuild the icon: `node build/generate-icon.js`.
