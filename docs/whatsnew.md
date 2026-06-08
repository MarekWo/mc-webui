# What's New

User-facing summary of changes since the last `main` release. Maintained on `dev` and finalized before each merge to `main`.

For deep technical notes, see [architecture.md](architecture.md). For the full git history, run `git log`.

---

## Unreleased (since fd2b3d0)

### New features

- **Custom Analyzer services.** A new **Settings → Analyzer** tab lets you register your own MeshCore Analyzer services. Each entry has an enable/disable switch, a "star" toggle to mark it as the default, and an Edit/Delete pair. The chart icon under each group-chat message now resolves at click time: built-in Letsmesh if you haven't configured anything, the default service when one is set, or a chooser modal when several are enabled. URL templates use `{packetHash}` as a placeholder.
- **Apply a saved path straight from Contact Info.** Each entry in the **Paths** list inside the DM Contact Info modal gained an upload-arrow button. Click it to push that configured path to the device as the active route — no more switching to the console to run `change_path`.
- **Database "Optimize now" button + live size.** The Backup modal now shows the current DB size and exposes an **Optimize now** button that runs SQLite `VACUUM` on demand. Useful after a big retention pass when you want to reclaim space without waiting for the nightly job.
- **Automatic message retention is on by default.** A nightly job at 03:30 (using your container's `TZ`) trims old data: 90 days of channel messages and direct messages, 60 days of advertisements, and 30 days of diagnostic data (echoes, paths, acks — these account for the bulk of long-term DB growth). When at least 1 000 rows are deleted, the database is `VACUUM`-ed automatically so file size shrinks too.
- **Smarter watchdog (host service).** The host-level `mc-webui-watchdog` systemd service now catches a new failure mode — a "sluggish" device that briefly stalls on stats/battery commands while still receiving traffic — by counting soft-pattern hits over a 2-minute window. The app also exposes a new `/health/strict` endpoint that external monitors can poll.

### Reliability & polish

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
