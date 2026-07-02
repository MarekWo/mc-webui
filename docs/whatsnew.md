# What's New

User-facing summary of changes since the last `main` release. Maintained on `dev` and finalized before each merge to `main`.

For deep technical notes, see [architecture.md](architecture.md). For the full git history, run `git log`.

---

## Unreleased (since debb711)

_Nothing yet — the next change to land on `dev` goes here._

---

## 2026-07-02

### New features

- **Explicit Send on phones and tablets.** On touch devices, pressing Enter now inserts a new line instead of sending — you tap the **Send** button to publish. This stops a mistapped Enter on the on-screen keyboard from firing off a half-typed message. Desktop keeps Enter-to-send. Applies to both group chat and direct messages.
- **Manage the Letsmesh analyzer like any other entry.** The built-in Letsmesh Analyzer is now a normal row in **Settings → Analyzer** — rename it, disable it, star it as the default, or delete it, just like a service you add yourself. The chart icon under a message resolves at click time: nothing enabled shows a "No analyzer configured" hint, a starred default (or a single enabled service) opens directly, and several enabled without a default show a chooser. The row's switch now reads **Enabled** when it's on.

### Reliability & polish

- **Multi-line direct messages keep their line breaks.** A DM you sent across several lines showed correctly to the recipient but collapsed to a single line in your own copy. Your own bubble now preserves the line breaks too.

---

## 2026-06-26

### New features

- **Resend a channel message (same packet).** Your own group-chat messages now carry a repeat-arrow button that re-broadcasts the *exact same* packet. Repeaters that already forwarded it stay quiet, but nodes that never heard it can still pick it up — so a resend fills in coverage on the existing message's delivery badge instead of posting a duplicate. Requires companion firmware 1.16 or newer; the button is hidden on older devices.
- **Clearer "Edit message" button.** The button that copies a message back into the composer for hand-editing used to be mislabeled "Resend." It's now a pencil **Edit message** button on both channel and direct messages, clearly separate from the real Resend above.
- **Custom Analyzer services.** A new **Settings → Analyzer** tab lets you register your own MeshCore Analyzer services. Each entry has an enable/disable switch, a "star" toggle to mark it as the default, and an Edit/Delete pair. The chart icon under each group-chat message now resolves at click time: built-in Letsmesh if you haven't configured anything, the default service when one is set, or a chooser modal when several are enabled. URL templates use `{packetHash}` as a placeholder.
- **Apply a saved path straight from Contact Info.** Each entry in the **Paths** list inside the DM Contact Info modal gained an upload-arrow button. Click it to push that configured path to the device as the active route — no more switching to the console to run `change_path`.
- **Database "Optimize now" button + live size.** The Backup modal now shows the current DB size and exposes an **Optimize now** button that runs SQLite `VACUUM` on demand. Useful after a big retention pass when you want to reclaim space without waiting for the nightly job.
- **Automatic message retention is on by default.** A nightly job at 03:30 (using your container's `TZ`) trims old data: 90 days of channel messages and direct messages, 60 days of advertisements, and 30 days of diagnostic data (echoes, paths, acks — these account for the bulk of long-term DB growth). When at least 1 000 rows are deleted, the database is `VACUUM`-ed automatically so file size shrinks too.
- **Smarter watchdog (host service).** The host-level `mc-webui-watchdog` systemd service now catches a new failure mode — a "sluggish" device that briefly stalls on stats/battery commands while still receiving traffic — by counting soft-pattern hits over a 2-minute window. The app also exposes a new `/health/strict` endpoint that external monitors can poll.

### Reliability & polish

- **System Log tab no longer floods the server.** Opening the System Log could trigger a feedback loop that hammered the server with 10+ requests a second; the log noise that caused it is now filtered out, so the tab stays quiet.
- **The connection badge stops lying about device state.** The status badge could flip back to "Connected" on a routine message refresh even while the device was actually disconnected. Device status is now driven only by real device connectivity, with a 60-second fallback check so a long-open tab stays accurate.
- **Automatic recovery after a failed reconnect.** A reconnect that failed quietly used to leave the app stuck "disconnected" until the container was restarted by hand. The background liveness watcher now keeps retrying instead of giving up after a single failure.
- **No more 10–15 s freezes on app load.** The realtime channel used a transport that the dev server couldn't upgrade; we now stay on long-polling, which keeps real-time pushes working without the reconnect loop.
- **Channel list stays complete when the device is slow.** Channels are now read from the local cache rather than re-queried slot-by-slot, so a brief device stall no longer leaves you with just the Public channel after a refresh.
- **Sending on a re-used channel slot now works after a deletion.** When you delete a channel, the device compacts the remaining slots — until now the app kept using the old keys for that slot. We refresh the secret from the device just before each send.
- **Region scopes work for all channels, not just slots 0–7.** Channels stored in higher slots (e.g. `#ubot`, `#swietokrzyskie`) now accept scope changes.
- **Multi-byte routing paths render correctly everywhere.** Contact list, DM modal, retry status, console output — all now show 2-byte and 3-byte hops with the right hop count and byte size (e.g. `D103,5E34 (2 hops, 2B)`), where they previously truncated the path or rendered single-byte hops.
- **Self-healing TCP connection.** Long-lived TCP sessions against `meshcore-proxy` can degrade in ways the socket can't see — some commands silently time out while RX still trickles in. The app now detects this on a send failure and reconnects in-place, with a backup liveness watcher that triggers a reconnect when no RX event has been seen for 5 minutes.
- **Settings analyzer modals: backdrop and URL wrapping.** Add/edit/chooser modals now dim the Settings backdrop correctly, and long URLs in the Analyzer list no longer push controls off-screen on narrow mobile viewports.
- **Console `change_path` accepts more formats and respects hop size.** You can now use commas, spaces, or arrows between hex chunks (`D103,5E34` / `D103 5E34` / `D1->90->05`). For multi-byte paths, all chunks must be the same length — that length determines whether the path is sent as 1-, 2-, or 3-byte hashes.

### Deploy notes

- After deploying this release, restart the host watchdog so it picks up the new soft-pattern detection:
  ```bash
  sudo systemctl restart mc-webui-watchdog.service
  ```
- The retention job runs the first time at 03:30 local. Your DB may shrink noticeably overnight — that's expected.

---

## How this file is maintained

This file is updated **before each merge of `dev` → `main`**. Each release section starts as **"Unreleased"** and is renamed/dated once the merge happens, then a fresh "Unreleased" section is opened at the top.

Sections are grouped roughly as:

- **New features** — things a user can find/click that didn't exist before
- **Reliability & polish** — fixes for problems users actually noticed, plus quality-of-life tweaks
- **Deploy notes** — anything the operator must do beyond the usual `mcupdate`

Internal refactors, code-level cleanups, and developer-only changes belong in `git log` and `architecture.md`, not here.
