# Trusted Actions — Design Notes (NOT YET IMPLEMENTED)

> **Status: groundwork / documentation only.** No command execution exists in the
> app today. The "Trusted actions" toggle in Settings is intentionally **disabled**.
> This file records the intended design so it can be built safely later.

## Goal

Let a *trusted, paired* machine trigger a **small, fixed set of safe actions** on the
other machine — e.g. "restart Homebase" from the Mac. This is for personal automation
between the user's own two machines, never a general remote shell.

## Hard safety rules (non-negotiable)

1. **No arbitrary shell commands. Ever.** The remote side can never send a string that
   is passed to a shell, `exec`, `eval`, or similar.
2. **Allow-list only.** Each action is a fixed identifier (e.g. `restart-homebase`) that
   maps to **one specific, pre-written script** shipped/configured locally. Unknown
   identifiers are rejected.
3. **Fixed scripts, no parameters from the wire** (or, if parameters are ever needed,
   they are strictly validated against an allow-list/enum — never free-form).
4. **Opt-in and disabled by default.** Command *execution* must be explicitly enabled by
   the user on the machine that would run them. Default = off, especially on Linux.
5. **Trusted device pairing required.** Actions are only accepted from a device that has
   completed an explicit pairing handshake and presents a valid shared token. A beacon on
   the LAN is not sufficient authorization.
6. **Confirmation before running** (configurable per action). A destructive action like
   restart prompts on the receiving machine — or is acknowledged on the sender — before it
   runs.
7. **Everything is logged.** Append-only log records: timestamp, source device id + name,
   action id, whether it was allowed, confirmation result, and the action's exit/result.

## Example future commands (allow-list)

| Action id              | What it would do (fixed script)                 | Destructive |
|------------------------|--------------------------------------------------|-------------|
| `status-homebase`      | Report uptime / service health                   | no          |
| `restart-homebase`     | Restart a specific known service/box             | yes (confirm) |
| `start-ghost-control`  | Launch a specific known control process          | yes (confirm) |
| `open-received-folder` | Open the Send It received-files folder           | no          |

Note `open-received-folder` already exists today as a **local** UI action — it's listed
here as the model for the *safest* possible action (no shell, just `shell.openPath`).

## Proposed architecture (when built)

- **Transport:** reuse the existing WebSocket peer link. Add a new message kind, e.g.
  `{ kind: 'action', id, nonce, token }` — separate from note/history messages.
- **Registry:** a local `actions` map: `id -> { run, destructive, confirm }`. `run` is a
  real function in main-process code (or a path to a vetted script), chosen by id. The map
  is the allow-list; there is no dynamic lookup from wire data.
- **Auth:** a per-pair shared token established during pairing, stored locally
  (never synced as note content). Reject actions without a matching token.
- **Gate:** execution is wrapped by a single `trustedActionsEnabled` flag (the Settings
  toggle) that defaults to `false`. If off, all action messages are logged and ignored.
- **Confirm + log:** before running a `destructive`/`confirm` action, show a native dialog;
  append the outcome to `~/Library/Application Support/Send It/actions.log` (or the Linux
  equivalent) regardless of allow/deny.
- **Linux execution:** disabled by default and clearly surfaced as opt-in, since this is
  the machine most likely to run privileged restarts.

## Explicitly out of scope (for now and for the placeholder)

- Running arbitrary terminal commands sent from the other machine.
- Passing untrusted strings to a shell.
- Any execution path that is enabled by default.

Until the rules above are fully implemented and reviewed, the feature stays disabled.
