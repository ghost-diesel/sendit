# Remote Terminal — Design Notes

> **Status: implemented** (branch `embedded-terminal`). Off by default on every
> machine. Enable it only on a box you explicitly want to expose a shell on.

## Goal

A live, interactive terminal pane in the Mac app that drives a **real shell** on a
paired peer (e.g. CloudCore/Homebase) — for tailing logs (`journalctl -f`), running
`top`/`vim`, controlling the box, etc. Because it's a true PTY, colors, `Ctrl-C`,
tab-completion, and full-screen TUIs all work.

This is **deliberately different from [Trusted Actions](TRUSTED_ACTIONS.md)**. Trusted
Actions is an allow-list of fixed, pre-written commands — never a shell. The Remote
Terminal *is* a general shell, so it's a separate, more powerful feature with its own
explicit opt-in and its own risk profile. They share nothing but the pairing code.

## Architecture

```
Mac (client / controller)             CloudCore (executor)
  xterm.js terminal pane                 node-pty real PTY ($SHELL)
        │  keystrokes / resize                 │
   preload → main → sync ──WS 50778──→ sync → terminal.js
        ▲  output / exit      (Tailscale)      │
        └───────────────────────────────────────┘
```

- **Client UI:** [`xterm.js`](../src/renderer/vendor/) (vendored UMD build + fit addon),
  opened from the toolbar terminal button. One session at a time.
- **Executor:** [`src/terminal.js`](../src/terminal.js) — a `node-pty` PTY manager.
- **Transport:** the existing per-peer WebSocket on TCP **50778**, which (per the current
  setup) runs over the **encrypted Tailscale tunnel**. New message kinds live in
  [`src/sync.js`](../src/sync.js): `term-open` / `term-opened` / `term-data` /
  `term-resize` / `term-close` / `term-exit`, plus a `term-state` capability advertisement.

## Hard safety rules (non-negotiable)

1. **Off by default.** A shell is exposed only when the user flips the **Remote Terminal**
   switch (Settings → Terminal) on the machine that would run it. Stored as
   `terminalEnabled` in `config.json`, default `false`.
2. **Separate from Trusted Actions.** Different toggle, different config flag, different
   code path. Turning one on never turns the other on.
3. **Pairing-code gated.** Every `term-open` is validated against the same pairing code as
   Trusted Actions (`sync._handleTermOpen`, modeled on `_handleRun`). A peer that hasn't
   presented the correct code gets nothing. A LAN/Tailscale beacon is **not** authorization.
4. **Connected link only.** Sessions exist only on a live, handshaked peer socket. When a
   peer disconnects, every PTY it owned is killed (`closePeer`) — no orphan shells.
5. **No privilege escalation.** The PTY runs the logged-in user's `$SHELL` as that user.
   The app does nothing to gain root.
6. **Bounded.** Per-peer session cap; sane min/max PTY dimensions.

> The pairing code is the lock. Keep it secret, and enable 2FA on the Tailscale account so
> the encrypted transport itself stays sound.

## Protocol

| Kind          | Dir              | Payload                          | Notes |
|---------------|------------------|----------------------------------|-------|
| `term-state`  | executor→client  | `{ enabled }`                    | Advertises whether a shell is exposed (drives the toolbar button). Sent at handshake + on toggle. |
| `term-open`   | client→executor  | `{ reqId, cols, rows, token }`   | Gated: enabled + valid pairing code. |
| `term-opened` | executor→client  | `{ reqId, sid, ok, error }`      | Ack; `sid` is the executor-assigned session id. |
| `term-data`   | both             | `{ sid, data }`                  | Disambiguated by session-id ownership: if the receiver owns `sid` it's keystrokes for its PTY (executor); otherwise it's output for its renderer (client). Also carries the replay buffer on attach. |
| `term-resize` | client→executor  | `{ sid, cols, rows }`            | |
| `term-list`   | client→executor  | `{ reqId, token }`               | Which of my sessions are still alive here? Reply `term-sessions { sessions:[{sid,seq,cols,rows}] }`. |
| `term-attach` | client→executor  | `{ reqId, sid, cols, rows, token }` | Reattach to a live session. Reply `term-attached { sid, seq, ok }`, then a `term-data` burst of the replay buffer. |
| `term-detach` | client→executor  | `{ sid }`                        | Close the panel but KEEP the shell running. |
| `term-close`  | client→executor  | `{ sid }`                        | Explicit ✕ → kill the PTY. |
| `term-exit`   | executor→client  | `{ sid, code }`                  | Shell exited → close the tab. |

## Persistence (detachable, tmux-style sessions)

Shells survive the client. The executor keeps a PTY running — and keeps buffering
its output — when the client closes the panel (`term-detach`) **or** the link
drops (a disconnect detaches that peer's sessions rather than killing them). On
reopen the client calls `term-list`, restores a tab per live session via
`term-attach`, and the executor replays a recent-output ring buffer
(`BUFFER_LIMIT`, 256 KB) so the screen repaints. A shell dies only on an explicit
`term-close` (the per-tab ✕), when its own process exits, on app shutdown, or via
the idle reaper (detached + no output for `IDLE_REAP_MS`, 4 h). This is what makes
"start `pacman -Syu`, close the lid, reattach later" safe. Up to 8 live sessions
per peer.

## node-pty (native module) — build notes

`node-pty` is a native addon. It ships prebuilt binaries for macOS and Windows but **not
Linux**, so on CloudCore/CI it compiles from source (needs a C/C++ toolchain + `python3`;
`build-linux.sh` checks for these).

- **Packaging:** `electron-builder` automatically rebuilds `node-pty` for Electron's ABI
  and, via `asarUnpack` (`node_modules/node-pty/**`), unpacks the native binary outside the
  asar. Linux needs only `pty.node` (it uses `forkpty` directly); the separate
  `spawn-helper` binary is a **macOS-only** target in node-pty's `binding.gyp` (and there it
  must keep its exec bit — a fresh npm extraction can strip it, but from-source/rebuild
  restores it). The CI workflow asserts `pty.node` made it into the Linux package.
- **Local dev (`npm start`):** run `npm run rebuild` once to rebuild `node-pty` against the
  installed Electron's ABI (uses `@electron/rebuild`). Without it, the lazy load in
  `terminal.js` fails *soft* — the feature is reported unavailable, the app still runs.
- **Headless test (`node test-terminal.js`):** runs under plain Node, so it needs the
  Node-ABI build (`npm rebuild node-pty`). The test skips cleanly if `node-pty` can't load.

## Testing

`test-terminal.js` is an end-to-end loopback test between two `Sync` instances: it checks
the capability advertisement, pairing-code gating (including a wrong-code rejection), a real
PTY echoing a command back, and clean teardown with no orphan sessions. The full
two-machine GUI run happens once CloudCore is updated to this code (a joint build → deploy →
test pass).
