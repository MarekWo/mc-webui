# mc-webui Architecture

Technical documentation for mc-webui, covering system architecture, project structure, and internal APIs.

## Table of Contents

- [Tech Stack](#tech-stack)
- [Container Architecture](#container-architecture)
- [DeviceManager Architecture](#devicemanager-architecture)
- [Project Structure](#project-structure)
- [Database Architecture](#database-architecture)
- [API Reference](#api-reference)
- [WebSocket API](#websocket-api)
- [Versioning & Releases](#versioning--releases)
- [Offline Support](#offline-support)

---

## Tech Stack

- **Backend:** Python 3.11+, Flask, Flask-SocketIO (gevent), SQLite
- **Frontend:** HTML5, Bootstrap 5, vanilla JavaScript, Socket.IO client
- **Deployment:** Docker / Docker Compose (Single-container architecture)
- **Communication:** Direct hardware access (USB, BLE, or TCP) via `meshcore` library
- **Data source:** SQLite Database (`./data/meshcore/<pubkey_prefix>.db`)

---

## Container Architecture

mc-webui uses a **single-container architecture** for simplified deployment and direct hardware communication:

```text
┌─────────────────────────────────────────────────────────────┐
│                     Docker Network                           │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                       mc-webui                        │   │
│  │                                                       │   │
│  │  - Flask web app (Port 5000)                          │   │
│  │  - DeviceManager (Direct USB/BLE/TCP access)          │   │
│  │  - Database (SQLite)                                  │   │
│  │                                                       │   │
│  └─────────┬─────────────────────────────────────────────┘   │
│            │                                                 │
└────────────┼─────────────────────────────────────────────────┘
             │
             ▼
      ┌──────────────┐
      │ USB/BLE/TCP  │
      │    Device    │
      └──────────────┘
```

Three transport options are supported with the following priority: **BLE > TCP > Serial (USB)**. Set the `MC_BLE_ADDRESS` or `MC_TCP_HOST` environment variable to activate BLE or TCP transport respectively; otherwise, USB serial is used by default.

This v2 architecture eliminates the need for a separate bridge container and relies on the native `meshcore` Python library for direct communication, ensuring lower latency and greater stability.

### Docker Entrypoint (BLE cleanup)

`scripts/docker-entrypoint.sh` runs before the Flask app starts. When `MC_BLE_ADDRESS` is set, it uses D-Bus to check if BlueZ has an active session to the device and disconnects it. BlueZ auto-reconnects trusted devices, which leaves stale GATT notification handles that block `bleak` from establishing a new session. A clean disconnect at startup ensures the app starts with a fresh BLE state.

### Multi-architecture Images

Official images are built via GitHub Actions for `linux/amd64`, `linux/arm64`, and `linux/arm/v7` (Raspberry Pi 2/3/4/5 supported). Build dependencies (`gcc`, `python3-dev`, `libjpeg-dev`, `zlib1g-dev`) are installed and then purged to keep the final image size small while still compiling `Pillow` and `pycryptodome` from source when wheels are unavailable (notably on `arm/v7`). GHA layer cache (`cache-from` / `cache-to`) speeds up subsequent rebuilds. Images are pushed to both Docker Hub (`mawoj/mc-webui`) and GitHub Container Registry (`ghcr.io/marekwo/mc-webui`), with `latest` tag on `main` and `dev` tag on the `dev` branch.

---

## DeviceManager Architecture

The `DeviceManager` handles the connection to the MeshCore device via a direct session:

- **Single persistent session** - One long-lived connection utilizing the `meshcore` library
- **Event-driven** - Subscribes to device events (e.g., incoming messages, advert receptions, ACKs) and triggers appropriate handlers
- **Direct Database integration** - Seamlessly syncs contacts, messages, and device settings to the SQLite database
- **Real-time messages** - Instant message processing via callback events without polling
- **Thread-safe queue** - Commands are serialized to prevent device lockups
- **Auto-restart watchdog** - Monitors connection health and restarts the session on crash
- **BLE keepalive & reconnect** - When using Bluetooth transport, a 60s keepalive loop detects "zombie" connections (reads still succeed but writes silently fail). On disconnect or keepalive failure, the manager marks the session as permanently failed and the `/health` endpoint returns 503, letting the Docker healthcheck trigger a fast container restart (~5s) to get a clean BLE state rather than attempting unreliable in-process reconnects
- **Echo correlation** - Sent channel messages pre-compute their expected `pkt_payload` using the channel secret and send timestamp (±3s for clock drift), so incoming echoes are matched exactly instead of only by 1-byte channel hash (prevents misattribution when two messages go out simultaneously on the same channel). Every recent send stays armed in `_pending_echoes` (one entry per message, capped at 32) rather than a single slot, so a resend or a back-to-back send can no longer swallow another message's echo; exact matching stays valid for 5 min because repeats do arrive minutes late, while the loose channel-hash fallback (no secret available) keeps its 60s window since it can grab a foreign message. A resend re-arms correlation from `_payload_from_raw_packet(raw_packet)` when the message has no `pkt_payload` yet, which is what lets it recover the badge of a message that missed its own echo
- **Per-channel region scope** - Before each channel send, the channel's mapped region scope key (16 bytes) is pushed to the firmware via `CMD_SET_FLOOD_SCOPE_KEY` (54). The scope-set + send pair is serialised under a `_send_lock` so concurrent sends on different channels can't swap each other's scope. Channels without a mapping get an all-zero key so a previously-set scope doesn't leak across channels
- **Per-send channel-secret refresh** - Channel indices on the device compact down after a deletion, so the boot-time `_load_channel_secrets()` cache can drift. `send_channel_message` calls `_refresh_channel_secret(idx)` first (one extra `get_channel(idx)` round-trip) to fetch the current secret straight from firmware, update the in-memory cache and DB if they had drifted, and use it for the `pkt_payload` echo correlation
- **Liveness telemetry** - Tracks `_last_rx_at` (bumped on every `RX_LOG_DATA` event) and `_consecutive_stats_failures` (incremented on `get_stats_*` / `get_bat` exceptions, cleared on success). Surfaced via `/health/strict` for the external watchdog
- **TCP self-heal** - A `_liveness_watcher_loop` task on the DM event loop calls `force_reconnect()` when no RX event has arrived for `HEALTH_STRICT_MAX_RX_STALE_SEC` (5 min). `send_channel_message` also detects empty-string `concurrent.futures.TimeoutError` from `set_flood_scope_key` (the symptom of a degraded long-lived TCP) and runs an in-place reconnect + one retry before failing. A 30 s cooldown and `_reconnect_lock` prevent churn; `_intentional_disconnect` keeps the DISCONNECTED handler from racing the reconnect. The watcher keeps re-checking staleness even after `_connected` has gone False, so a single failed reconnect (e.g. an empty `self_info`) no longer silently stops all further healing for non-BLE transports
- **Raw packet resend** - Own channel sends capture a full hex wire snapshot (`header + transport_codes + path_len + encrypted payload`) into `channel_messages.raw_packet`, rebuilt from the actual `pkt_payload` once echo correlation resolves it and honouring the device's cached `path_hash_mode`. `resend_channel_message()` re-broadcasts that snapshot verbatim via `CMD_SEND_RAW_PACKET` (0x41) so repeaters dedupe by packet hash (`Mesh::hasSeen`) and only previously-unreached nodes pick it up. Requires companion firmware ≥1.16 (`fw_ver_code` ≥ 13), gated via the cached `supports_raw_resend` flag captured from the connect-time `DEVICE_INFO` event. Self-echoes of a resend (the firmware seen-table can evict the hash within minutes on a busy mesh) are detected by recomputing the expected `pkt_payload` and matching an existing own row, so a resend never reappears as an inbound message from yourself

### Observer (MQTT packet capture)

`app/observer.py` (`ObserverManager`) implements a meshcore-packet-capture-compatible observer on top of the existing device session — no second connection and no device-side enable command (the firmware pushes `RX_LOG_DATA` for every overheard frame):

- **Hot path** — `_on_rx_log_data` hands every packet (all payload types, before the GRP_TXT echo gate) to `handle_raw_packet()`: pure CPU work (header/path decode, firmware-exact packet hash, JSON build) plus a non-blocking paho `publish()`, wrapped in its own try/except so observer failures can never affect chat
- **One paho-mqtt client per enabled broker**, each with its own network thread (`loop_start`), auto-reconnect with backoff, QoS 0 (no backlog during outages), retained `online`/`offline` status plus an LWT on `meshcore[/IATA/PUBKEY]/status`; packets go to `.../packets` (flat `meshcore/packets|status` when IATA is unset)
- **Wire-format fidelity** — the decode/hash/format functions are verbatim ports of upstream meshcore-packet-capture (including legacy path-length fallbacks and the publish-with-defaults quirk for unknown payload versions), validated byte-identical against live packets from the reference observer network
- **Config** — `observer_brokers` table plus the `observer_settings` JSON key (`enabled`, `iata`, `advert_interval_hours`) in `app_settings`; every mutating API call triggers `reload()` on a daemon thread (the client list is swapped atomically and the hot path reads it lock-free), so changes apply without restart
- **Advert scheduler** — an observer-owned daemon thread checks every 10 minutes and sends a flood advert once `advert_interval_hours` has elapsed since the `observer_last_advert_at` timestamp persisted in `app_settings` (restart-safe)
- **Live status** — `observer_status` events on the `/chat` namespace (throttled to one per 2 s on the packet path) drive the Settings-tab badges and counters; `GET /api/observer/status` returns the full merged view

### Diagnostic capture (support bundle)

`app/diagnostics.py` (`DiagnosticsManager`) records a bounded window of device traffic into a zip the user can hand to a maintainer who has no access to their machine. It answers a question the database cannot: whether a missing route badge means "nobody repeated it" or "the repeat never crossed the companion link".

- **Why the device counter matters** — `logRxRaw()` in the firmware pushes every overheard packet through `writeFrame()`, which drops the frame when its 4-entry queue is full and ignores the return value, so the loss is invisible to the host (no log, no counter). Drain rates differ hugely: USB writes with no queue, WiFi/TCP sends one frame per main-loop pass, BLE at most one per 60 ms (`BLE_WRITE_MIN_INTERVAL`). The capture brackets its window with `get_device_stats()` calls and samples again every 60 s, so `stats.packets.recv` delta versus the number of RX-log frames actually captured turns that invisible loss into a measurement
- **Hot path** — the same threading contract as the Observer, for the same reason. `record()` builds one dict and appends to a `deque`; no disk, no network, no locks. `threading.Event.set()` is deliberately avoided (it takes a lock), so the writer polls at 0.4 s instead of being signalled. Call sites test the plain `recording` attribute before building arguments, so an idle capture costs one attribute load
- **Taps** — `_on_rx_log_data` (**before** the empty-payload guard, so the frame count matches what the device counted), `_process_echo` (match rule that fired, plus a snapshot of the pending-send list — that is what explains a *non*-match), and `send_channel_message` (expected payloads, `raw_packet`, region scope). A `logging.Handler` mirrors log records through the same queue; it uses a no-op lock object rather than `lock = None`, because Python 3.13's `Handler.handle()` uses `with self.lock`
- **Log level** — a capture raises the root logger to DEBUG for its duration and restores it on stop. Without that, a server at the default INFO emits none of the lines the echo correlator writes about its own decisions, and the log file is worthless
- **Writer thread** — one per session, owns every file handle, demultiplexes log records into `log.txt` and everything else into `events.jsonl`, enforces the caps, and performs the whole finalize-and-zip sequence. Stopping never runs on the caller's thread: a request thread raises a flag and joins, so both a user stop and an auto-stop finalise through the same path
- **Caps and retention** — 5/15/30/60 min and 25 MB (hard limit 100 MB), whichever fills first; at most 10 captures kept, oldest pruned on start. `/data` is the user's config directory, so these are not optional
- **Contents** — `meta.json` (versions, transport, device, options, counters, stop reason), `stats_before.json` / `stats_after.json`, `events.jsonl`, `log.txt`. Every timestamp is **UTC epoch seconds**, stated in `meta.json`, because the DB writes UTC and container logs are local time
- **Privacy** — the capture contains the plaintext of every message received while recording, plus contact names and public keys. This is stated in the UI and confirmed before upload. Channel secrets and broker credentials are never included; ciphertext payloads are enough for correlation analysis
- **Upload** — `POST /api/upload` against a Zipline instance: bare `authorization` token (no `Bearer`), one multipart `file` field, `x-zipline-original-name: true`, link read from `.files[0].url` (the older `files: ["url"]` shape is accepted too). The default URL ships in the code; **the token never does** — this repository is public, so a baked-in write token would let anyone upload anything. The user pastes a token handed to them out-of-band, and the API is write-only for it
- **Offline analysis** — `scripts/diag_report.py <capture.zip>` prints the frame-loss comparison, per-interval detail, inter-frame gap distribution, and a per-sent-message verdict (echo heard / heard but not correlated, with the pending list / no echo at all). It reads nothing but the capture

### Repeater administration (My Repeaters)

The `/repeaters` (list) and `/repeaters/manage` (per-repeater tools) panels are standalone iframe pages built on the companion protocol's remote-request commands plus the repeater text CLI:

- **Serialization** — the companion firmware tracks a single pending remote request (each new send silently clears the previous one), so every repeater operation runs under `DeviceManager._repeater_lock` (180 s acquire timeout; a held lock returns `{'busy': True}` → HTTP 429). This also guards against two browser tabs operating at once
- **Login sessions** — `repeater_login()` waits for `LOGIN_SUCCESS` filtered by the contact's `pubkey_prefix` and stores `{is_admin, permissions, logged_in_at}` in the in-memory `_repeater_sessions` dict (cleared on logout/app restart; the UI auto-relogs with the saved password). All remote endpoints fail fast with 401 `need_login` when no session exists — a repeater only answers pubkeys in its ACL, so requesting without a login would just burn a multi-minute timeout. A wrong password is indistinguishable from an unreachable repeater (the firmware never replies to failed logins), so timeout messages always name both causes
- **CLI reply correlation** — `repeater_cmd_wait()` sends one text command and blocks for its reply. Replies arrive as `CONTACT_MSG_RECV` with `txt_type=1` (CLI_DATA) and carry no protocol-level correlation, so correlation = the repeater lock (single command in flight) + a single-slot waiter matched against the sender's 12-hex pubkey prefix at the top of `_on_dm_received`. Matched replies are consumed there and never stored as chat DMs; unmatched CLI replies keep the legacy behavior (stored as a DM) so the Console's fire-and-forget `cmd` flow is unchanged. Wait time derives from the device-suggested timeout (clamped 10–45 s)
- **Settings batches** — reads run sequential `get <field>` commands per section and parse the firmware's `> value` replies, reporting per-field errors without failing the batch; writes send only dirty fields and classify each reply as `ok` (starts with `ok`/`password now`), `reboot_required` (reply mentions reboot — e.g. `set radio`), or `failed` (anything else, surfaced verbatim). Connection-level failures abort the rest of the batch
- **Role gating** — the firmware silently drops text CLI from non-admin logins (which would surface as a timeout), so the CLI/Settings/Actions endpoints reject guest sessions with 403 up front instead
- **Actions whitelist** — `advert.zerohop`, `advert` (flood), `clock sync`, `reboot`. `reboot` never replies (the firmware restarts immediately without building one), so a clean send followed by silence is reported as success. Text `erase` is firmware-gated to the USB serial console (`sender_timestamp == 0`), hence no erase in the UI

### Path Analyzer

The `/path-analyzer` panel (standalone iframe page, `path-analyzer.js`) is a read-only analysis view over data the app already collects — no new tables, no background work:

- **Data source** — `GET /api/path-analyzer/messages?days=N` joins `channel_messages` with `echoes` (path hex + SNR + per-echo `hash_size`, keyed by `pkt_payload`). Echoes are fetched with `db.get_echoes_for_payloads()` — chunked `IN` queries (≤500 params, under SQLite's host-parameter limit) via `idx_echoes_pkt` — deliberately avoiding the per-message echo query the older `/api/messages` path still does. The pkt_payload reconstruction (raw_json text → channel-secret AES/HMAC compute) is shared with `/api/messages` via the `_get_row_pkt_payload()` helper
- **All filtering/stats/map/routes logic is client-side** over the bulk payload (hundreds of KB for 7 days — fine on a LAN): filters operate on per-hop tokens split with each echo's own `hash_size` (mixed 1/2/3-byte networks are real), so SQL-side token filtering was rejected. Every view always reflects the active filters for free
- **Four views** share the one payload: Messages (hop-by-hop echo detail), Repeaters (per-hash relay/SNR stats), Routes (consecutive hop-segment n-grams — user-selectable length 2–4, counted anywhere in a path), and Map (Leaflet path drawing). The repeater filter accepts a `>`-chained sequence (each element a hash prefix or contact name) matched as consecutive hops; Routes rows write such a sequence into that filter on click
- **Deep link** — `GET /path-analyzer?hash=<packet_hash>&path=<echo path hex>` opens straight on the Map view with that message selected and that exact echo drawn. Used by the chat path popup (`app.js` → `openPathInAnalyzer` stashes `{hash, path}` in `window.paDeepLink`; the modal's `show.bs.modal` handler builds the iframe URL). On load the analyzer resolves the message by `packet_hash`, widening the time range once to 7 days if it isn't in the current window, and matches the echo by raw path hex (fallback: shortest routed echo)
- **Map layers** — three `L.layerGroup`s added in draw order (base repeater markers → alternative echoes → selected path), both extras gated by opt-in checkboxes in a `topright` `L.Control` (the shared filter bar is wrong for view-specific state). Alternative echoes are coloured by their index in `echoView`, so a hue survives changing which echo is primary; segments are deduplicated against a `Set` of endpoint-pair keys that the primary path fills first, so alternatives render only where they diverge instead of underneath the primary line. Toggling calls `paRenderMapView(false)` — a full re-render (the sidebar swatches must follow) with `fitBounds` suppressed, so overlay changes never discard the user's viewport
- **Filter persistence** — toolbar controls plus the Routes segment length are mirrored into `localStorage` under `mc-webui-pa-filters` (browser-local working set, deliberately not device state in SQLite). Only user-driven handlers write, via `paApplyAndSaveFilters()`, so programmatic changes — notably the deep link forcing 7 days — never overwrite the stored set; restore is skipped entirely when `paDeepLink` is present, and stored `<select>` values that no longer exist as options are ignored. `paRestoreFilters()` ends with `paReadFilters()` so `paFilters`, the Clear button, and the mobile badge match the restored DOM before the first render
- **SNR attribution** — echo SNR is measured at our receiver, so stats credit it to the *final* hop only; intermediate hops get relay counts but never SNR
- **Hash→contact resolution** — pubkey-prefix match against `/api/contacts/cached?format=full` (memoized per token). 1-byte hashes collide by design; the map renders unresolved hops as amber candidate markers with manual pick, and the repeater-name filter is intentionally inclusive over candidates
- Legacy rows whose `pkt_payload` cannot be recomputed (missing channel secret) are returned with `packet_hash: null` and no echoes rather than dropped

---

## Project Structure

```text
mc-webui/
├── Dockerfile                      # Main app Docker image
├── docker-compose.yml              # Single-container orchestration
├── app/
│   ├── __init__.py
│   ├── main.py                     # Flask entry point + Socket.IO handlers
│   ├── config.py                   # Configuration from env vars
│   ├── database.py                 # SQLite database models and CRUD operations
│   ├── device_manager.py           # Core logic for meshcore communication
│   ├── observer.py                 # Observer: MQTT packet-capture publishing
│   ├── diagnostics.py              # Diagnostic capture (support bundle + upload)
│   ├── contacts_cache.py           # Persistent contacts cache (DB-backed)
│   ├── read_status.py              # Server-side read status manager (DB-backed)
│   ├── version.py                  # Git-based version management
│   ├── migrate_v1.py               # Migration script from v1 flat files to v2 SQLite
│   ├── meshcore/
│   │   ├── __init__.py
│   │   ├── cli.py                  # Meshcore library wrapper interface
│   │   └── parser.py               # Data parsers
│   ├── archiver/
│   │   └── manager.py              # Archive scheduler and management
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── api.py                  # REST API endpoints
│   │   └── views.py                # HTML views
│   ├── static/                     # Frontend assets (CSS, JS, images, vendors)
│   │   └── js/fab-utils.js         # Floating-button drag/collapse/sizing helpers
│   └── templates/                  # HTML templates
├── docs/                           # Documentation
├── scripts/
│   ├── diag_report.py              # Offline analyser for a diagnostic capture
│   ├── update.sh                   # Automated update script
│   ├── docker-entrypoint.sh        # Container startup (BLE cleanup)
│   ├── updater/                    # Remote update webhook service
│   └── watchdog/                   # Container health monitor
└── README.md
```

---

## Database Architecture

mc-webui v2 uses a robust **SQLite Database** with WAL (Write-Ahead Logging) enabled.

Location: `./data/meshcore/<pubkey_prefix>.db`

Key tables:
- `messages` - All channel and direct messages (with FTS5 index for full-text search)
- `contacts` - Contact list with sync status, types, block/ignore flags, `no_auto_flood` flag
- `channels` - Channel configuration and keys
- `echoes` - Sent message tracking and repeater paths, `hash_size` for path_hash_mode
- `direct_messages` - DM messages with delivery tracking (`delivery_status`, `delivery_attempt`, `delivery_max_attempts`, `delivery_path`)
- `acks` - DM delivery status
- `settings` - Application settings (migrated from .webui_settings.json)
- `regions` - User-curated MeshCore flood scopes (`name`, `key_hex`, `is_default`)
- `channel_scopes` - Per-channel region mapping (`channel_idx` → `region_id`, CASCADE on region delete; absent row = no override → firmware default applies)
- `read_status` - Per-channel read counters and favorites (`is_favorite` column; used to pin channels in the sidebar/dropdown sort order)
- `analyzers` - User-configured MeshCore Analyzer services (`name`, `url_template` with `{packetHash}` placeholder, `is_default`, `is_disabled`; partial unique index enforces a single default)
- `observer_brokers` - MQTT brokers for the Observer packet-capture feature (`name`, `host`, `port`, `username`, `password` — stored plaintext, `use_tls`, `tls_verify`, `is_disabled`)
- `repeaters` - Repeaters saved in the My Repeaters panel (`public_key` PK, `password` — stored plaintext per the observer_brokers precedent, `added_at`, `last_login_at`, `last_login_role`). Everything else about a repeater (name, path, position) comes from the device contact at read time

`direct_messages` gained a `delivery_path_hash_size` column (auto-migrated, defaults to 1) so reloaded DM bubbles render multi-byte routes correctly. The `path_len` column on `channel_messages`, `direct_messages`, and `paths` now stores the raw firmware byte (masked hop count plus path_hash_mode in the upper bits), recombined at write time via `pack_path_len()`; the API endpoints decode it back into `path_hash_size` on read. `channel_messages` also gained a `raw_packet` column (the full hex wire snapshot captured at send time, indexed by `idx_cm_pkt` on `pkt_payload` for fast self-echo lookups) that powers raw resend; it is `NULL` for received and pre-migration rows, so the resend button stays disabled there.

The use of SQLite allows for fast queries, reliable data storage, full-text search, and complex filtering (such as contact ignoring/blocking) without the risk of file corruption inherent to flat JSON files.

### Retention scheduler

Retention is enabled by default with `90 / 90 / 60 / 30` days for `channel_messages / direct_messages / advertisements / diagnostics`. The job runs daily at 03:30 local (`TZ` from `.env`) and `cleanup_old_messages()` also deletes from `echoes`, `paths`, and `acks` (the diagnostic tables — historically the bulk of DB size). When at least 1 000 rows are removed in a pass, the scheduler immediately runs `VACUUM` to reclaim file space (a SQLite `DELETE` only marks pages free).

The retention/cleanup scheduler runs APScheduler jobs in worker threads, so each job is decorated with `@_with_app_context` and the Flask app is passed in via `set_flask_app()`; the `init_*_schedule()` callers also wrap themselves in `app.app_context()` so the boot-time read of `current_app.db` doesn't blow up with "Working outside of application context".

The archiver builds the `.msgs` path from `device_name`, but the `meshcore` library strips non-ASCII when writing the file (so a device renamed to include an emoji breaks the strict path match). The archiver now falls back to globbing the data directory for a single non-archive `.msgs` file when the expected path is missing — mirroring `migrate_v1`.

The channels API reads from the `channels` DB table rather than iterating device slots. `_load_channel_secrets()` syncs the table on every device connect (and prunes stale rows), `set_channel()` / `remove_channel()` update it synchronously with the device, and `_refresh_channel_secret()` refreshes individual rows on per-send refresh. This makes `/api/channels` a single sub-millisecond `SELECT` and unaffected by device responsiveness — the original symptom (only "Public" showing up after a refresh when the device briefly stalls) is gone.

---

## API Reference

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages` | List messages (`?archive_date`, `?days`, `?channel_idx`) |
| POST | `/api/messages` | Send message (`{text, channel_idx, reply_to?}`) |
| GET | `/api/messages/updates` | Check for new messages (smart refresh) |
| GET | `/api/messages/<id>/meta` | Get message metadata (echoes, paths) |
| POST | `/api/messages/<id>/resend` | Re-broadcast an own channel message verbatim via `CMD_SEND_RAW_PACKET` (same packet hash, so unreached repeaters pick it up). 400 for not-own / missing `raw_packet` snapshot / disconnected / firmware < 1.16, 404 for unknown id |
| GET | `/api/messages/search` | Full-text search (`?q=`, `?channel_idx=`, `?limit=`) |
| GET | `/api/path-analyzer/messages` | Bulk channel messages across **all** channels with batched echo data (`?days=1..30`, default 3); powers the Path Analyzer panel (`GET /path-analyzer`) |

### Contacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/contacts` | List contacts |
| GET | `/api/contacts/detailed` | Full contact data (includes protection, ignore, block flags) |
| GET | `/api/contacts/cached` | Get cached contacts (superset of device contacts) |
| POST | `/api/contacts/delete` | Soft-delete contact (`{selector}`) |
| POST | `/api/contacts/cached/delete` | Delete cached contact |
| GET | `/api/contacts/protected` | List protected public keys |
| POST | `/api/contacts/<key>/protect` | Toggle contact protection |
| POST | `/api/contacts/<key>/ignore` | Toggle contact ignore |
| POST | `/api/contacts/<key>/block` | Toggle contact block |
| GET | `/api/contacts/blocked-names` | Get blocked names count |
| POST | `/api/contacts/block-name` | Block a name pattern |
| GET | `/api/contacts/blocked-names-list` | List blocked name patterns |
| POST | `/api/contacts/preview-cleanup` | Preview cleanup criteria |
| POST | `/api/contacts/cleanup` | Remove contacts by filter |
| GET | `/api/contacts/cleanup-settings` | Get auto-cleanup settings |
| POST | `/api/contacts/cleanup-settings` | Update auto-cleanup settings |
| GET | `/api/contacts/pending` | Pending contacts (`?types=1&types=2`) |
| POST | `/api/contacts/pending/approve` | Approve pending contact |
| POST | `/api/contacts/pending/reject` | Reject pending contact |
| POST | `/api/contacts/pending/clear` | Clear all pending contacts |
| POST | `/api/contacts/manual-add` | Add contact from URI or params |
| POST | `/api/contacts/<key>/push-to-device` | Push cached contact to device |
| POST | `/api/contacts/<key>/move-to-cache` | Move device contact to cache |
| GET | `/api/contacts/repeaters` | List repeater contacts (for path picker) |
| GET | `/api/contacts/<key>/paths` | Get contact paths |
| POST | `/api/contacts/<key>/paths` | Add path to contact |
| PUT | `/api/contacts/<key>/paths/<id>` | Update path (star, label) |
| DELETE | `/api/contacts/<key>/paths/<id>` | Delete path |
| POST | `/api/contacts/<key>/paths/reorder` | Reorder paths |
| POST | `/api/contacts/<key>/paths/<id>/apply` | Push a configured path to the firmware as the active route (mirrors `change_path`); invalidates the contacts cache |
| POST | `/api/contacts/<key>/paths/reset_flood` | Reset to FLOOD routing |
| POST | `/api/contacts/<key>/paths/set_direct` | Set the device path to Direct (empty path → `out_path_len = 0`); configured paths are kept |
| POST | `/api/contacts/<key>/paths/clear` | Clear all paths |
| GET | `/api/contacts/<key>/no_auto_flood` | Get "Keep path" flag |
| PUT | `/api/contacts/<key>/no_auto_flood` | Set "Keep path" flag |

### Channels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List all channels |
| POST | `/api/channels` | Create new channel (idempotent — returns existing slot if name already used) |
| POST | `/api/channels/join` | Join existing channel (idempotent unless explicit `index` overrides) |
| DELETE | `/api/channels/<index>` | Remove channel |
| GET | `/api/channels/<index>/qr` | QR code (`?format=json\|png`) |
| GET | `/api/channels/muted` | Get muted channels |
| POST | `/api/channels/<index>/mute` | Toggle channel mute |
| GET | `/api/channels/scopes` | Bulk per-channel region mapping for UI |
| PUT | `/api/channels/<index>/scope` | Assign/clear region scope (`{region_id: int\|null}`) |
| GET | `/api/channels/favorites` | List favorite channel indices |
| POST | `/api/channels/<index>/favorite` | Set favorite state (`{favorite: bool}`) |

### Regions (MeshCore flood scopes)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/regions` | List the device's region registry |
| POST | `/api/regions` | Create region (`{name}`); key derived as `SHA256('#'+name)[:16]` |
| DELETE | `/api/regions/<id>` | Delete region; CASCADE clears channel mappings; if it was the firmware default, clears it on device |
| POST | `/api/regions/<id>/default` | Mark default in DB AND push to firmware (CMD_SET_DEFAULT_FLOOD_SCOPE = 63, requires firmware v1.15+) |
| DELETE | `/api/regions/default` | Clear default region in DB and on firmware |

The `PUT /api/channels/<index>/scope` endpoint accepts any `index` in `[0, device_manager._max_channels)` (40 on current firmwares; falls back to 8 if the DM is unreachable).

### Analyzers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analyzers` | List configured analyzer services |
| POST | `/api/analyzers` | Create analyzer (`{name, url_template}`); template must contain `{packetHash}` |
| PUT | `/api/analyzers/<id>` | Update analyzer (name / url / is_disabled) |
| DELETE | `/api/analyzers/<id>` | Delete analyzer |
| POST | `/api/analyzers/<id>/default` | Mark as default (enforced single-default via partial unique index) |
| DELETE | `/api/analyzers/default` | Clear the default analyzer |

The backend no longer ships a pre-built `analyzer_url` per message — channel-message payloads include `packet_hash` instead, and the frontend substitutes `{packetHash}` in the chosen URL template at click time. The Letsmesh Analyzer is not a hardcoded pseudo-row: `seed_default_analyzers()` inserts it as an ordinary `analyzers` row exactly once per install (guarded by the `analyzer_letsmesh_seeded` flag in `app_settings`), so it can be renamed, disabled, or deleted like any user entry. The row stores `is_disabled` (not `is_enabled`); the UI inverts it on read/write so the switch reads "Enabled", which is why no data migration was needed.

### Observer

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/observer/settings` | Get observer settings (`enabled`, `iata`, `advert_interval_hours`) |
| POST | `/api/observer/settings` | Partial update; IATA must be empty or exactly 3 letters, interval 0-8760 h |
| GET | `/api/observer/brokers` | List MQTT brokers (passwords never returned; a `has_password` flag instead) |
| POST | `/api/observer/brokers` | Create broker (`{name, host, port?, username?, password?, use_tls?, tls_verify?}`) |
| PUT | `/api/observer/brokers/<id>` | Partial update; omitted `password` keeps the stored one, empty string clears it |
| DELETE | `/api/observer/brokers/<id>` | Delete broker |
| GET | `/api/observer/status` | Settings + broker rows merged with live connection state and packet counters |

Every mutating endpoint hot-reloads the `ObserverManager`, so broker and setting changes take effect without an app restart.

### Diagnostics (support capture)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/diagnostics/status` | Live capture state, stored captures, upload config (never the token), and the allowed duration choices |
| POST | `/api/diagnostics/start` | Begin recording (`{duration_min, max_mb, debug_logs, note}`; 409 when one is already running). Caps are re-clamped server-side |
| POST | `/api/diagnostics/stop` | Stop and finalise; blocks until the zip is written (409 when idle) |
| GET | `/api/diagnostics/captures/<id>/download` | Download a stored capture |
| POST | `/api/diagnostics/captures/<id>/upload` | Send a capture to the configured share service, returns the link |
| DELETE | `/api/diagnostics/captures/<id>` | Delete a stored capture |
| POST | `/api/diagnostics/upload-settings` | Save share URL / token (`{url, token}`; the token is write-only, an absent key keeps the stored one) |

`GET /api/status` also carries `diagnostics_recording`, which drives the recording marker in the chat status bar.

### My Repeaters (repeater administration)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/repeaters` | Saved repeaters merged with device contact truth (`?refresh=true` bypasses the contacts cache) |
| POST | `/api/repeaters` | Add a repeater (`{public_key}`; 409 when already saved) |
| GET | `/api/repeaters/<pk>` | Single merged entry + login session state |
| PUT | `/api/repeaters/<pk>` | Set or clear the saved password (`{password}`; empty string clears) |
| DELETE | `/api/repeaters/<pk>` | Remove from the list (device contact untouched) |
| GET | `/api/repeaters/<pk>/password` | Saved password (empty string when none); prefills the login-retry prompt for the trusted local UI |
| POST | `/api/repeaters/<pk>/login` | Log in with `{password?, save?}` — omitted password uses the saved one |
| GET | `/api/repeaters/<pk>/session` | In-memory session state (`logged_in`, `is_admin`, `permissions`) |
| POST | `/api/repeaters/<pk>/logout` | Log out and drop the session |
| GET | `/api/repeaters/<pk>/status` | Binary status request (battery, radio, packet stats) |
| GET | `/api/repeaters/<pk>/clock` | Repeater clock (LE epoch from `req_basic_sync`) |
| GET | `/api/repeaters/<pk>/telemetry` | All Cayenne LPP channels |
| GET | `/api/repeaters/<pk>/neighbours` | Zero-hop neighbours enriched with contact names/positions |
| POST | `/api/repeaters/<pk>/cli` | Text CLI command (`{command}` → `{output, elapsed_ms}`); admin only |
| GET | `/api/repeaters/<pk>/settings` | Read one settings section (`?section=basic\|radio\|location\|features\|network\|advert\|operator\|advanced`) as a `get` batch; admin only |
| POST | `/api/repeaters/<pk>/settings` | Apply dirty fields (`{values}`) as a `set` batch with per-field `ok\|failed\|reboot_required` results; admin only |
| POST | `/api/repeaters/<pk>/action` | One-shot action (`{action: zerohop_advert\|flood_advert\|clock_sync\|reboot}`); admin only |

Error mapping is shared across the family: 401 `need_login` (no session), 403 (guest on an admin endpoint), 429 (another repeater operation in progress — single firmware request slot), 503 (device not connected), 504 (timeout: repeater unreachable *or* wrong password — indistinguishable by protocol). Passwords are never returned by any GET (`password_set` boolean only). The panels are served by `GET /repeaters` and `GET /repeaters/manage?pubkey=<64-hex>`.

### Direct Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dm/conversations` | List DM conversations |
| GET | `/api/dm/messages` | Get messages (`?conversation_id=`, `?limit=`) |
| POST | `/api/dm/messages` | Send DM (`{recipient, text}`) |
| GET | `/api/dm/updates` | Check for new DMs |
| GET | `/api/dm/auto_retry` | Get DM retry configuration |
| POST | `/api/dm/auto_retry` | Update DM retry configuration |

### Device & Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status (device name, transport type, serial port / BLE address). When connected also surfaces `fw_ver_code`, `supports_raw_resend`, `path_hash_mode`, and `path_hash_size` so the frontend can show/hide the raw-resend button and verify the resend snapshot's hash size |
| GET | `/api/device/info` | Device information |
| GET | `/api/device/stats` | Device statistics |
| GET | `/api/device/settings` | Get device settings |
| POST | `/api/device/settings` | Update device settings |
| GET | `/api/device/config` | Get device configuration (name, coords, advert_loc_policy, path_hash_mode, radio params, tx_power) |
| POST | `/api/device/config` | Update device configuration from Settings > Device tab. Subset of fields incl. `path_hash_mode` (0=1B, 1=2B, 2=3B) |
| POST | `/api/device/command` | Execute command (advert, floodadv) |
| GET | `/api/device/commands` | List available special commands |
| GET | `/api/chat/settings` | Get chat settings (quote length, route popup timeout/no-autoclose) |
| POST | `/api/chat/settings` | Update chat settings |
| GET | `/api/ui/settings` | Get UI settings (toast timeout, no-autoclose, position) |
| POST | `/api/ui/settings` | Update UI settings |
| GET | `/api/retention-settings` | Get message retention settings |
| POST | `/api/retention-settings` | Update retention settings |

### Archives & Backup

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/archives` | List archives |
| POST | `/api/archive/trigger` | Manual archive |
| GET | `/api/backup/list` | List database backups |
| POST | `/api/backup/create` | Create database backup |
| GET | `/api/backup/download` | Download backup file |
| GET | `/api/db/size` | Current DB file size (bytes) |
| POST | `/api/db/vacuum` | Kick off SQLite `VACUUM` in a worker thread. Returns 202 immediately; 409 if already running. The kickoff endpoint deliberately splits from polling so reverse proxies with ~30 s idle timeouts can't kill it mid-rewrite |
| GET | `/api/db/vacuum/status` | Poll vacuum progress: `{running, elapsed_seconds, size_before, size_after}` |

### Health endpoints

These are top-level routes (not under `/api/`), consumed by Docker's healthcheck and the host-level watchdog.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Lenient liveness check. Returns 503 only when BLE reconnection has permanently failed (so Docker triggers a container restart to clear BLE state). Returns 200 otherwise |
| GET | `/health/strict` | Strict device-health check for the external watchdog. JSON response. Returns 503 when (a) BLE permanently failed, (b) `_consecutive_stats_failures` ≥ 5, or (c) transport is serial/usb/tcp and no RX event for > `HEALTH_STRICT_MAX_RX_STALE_SEC` (5 min). Returns 200 with the same counters when healthy |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/read_status` | Get server-side read status |
| POST | `/api/read_status/mark_read` | Mark messages as read |
| POST | `/api/read_status/mark_all_read` | Mark all messages as read |
| GET | `/api/version` | Get app version |
| GET | `/api/check-update` | Check for available updates |
| GET | `/api/updater/status` | Get updater service status |
| POST | `/api/updater/trigger` | Trigger remote update |
| GET | `/api/advertisements` | Get recent advertisements |
| GET | `/api/console/history` | Get console command history |
| POST | `/api/console/history` | Save console command |
| DELETE | `/api/console/history` | Clear console history |
| GET | `/api/console/output` | Get persisted console output transcript (capped at 500 entries) |
| POST | `/api/console/output` | Append entry to transcript |
| DELETE | `/api/console/output` | Clear transcript |
| GET | `/api/logs` | Get application logs |

---

## WebSocket API

All Socket.IO clients (`/chat`, `/console`, `/logs`) use the default transports: connect over long-polling, then upgrade to a real WebSocket. Where the upgrade is blocked (a reverse proxy that drops the `Upgrade` header) the client stays on polling by itself, so no configuration is needed either way.

From 2026-06-07 to 2026-07-31 the clients pinned `transports: ['polling'], upgrade: false`, because the Werkzeug server then had no WebSocket support and every `io()` upgrade attempt returned HTTP 500, producing a reconnect loop and 10–15 s freezes on app load. That stopped being true when `python-engineio==4.8.1` was pinned (2026-07-14) and pulled in `simple-websocket`, which teaches Werkzeug to serve WebSockets.

**Do not re-pin polling.** Long-polling holds one HTTP connection open per tab for the life of the tab, and browsers allow only six concurrent HTTP/1.1 connections per origin *across all tabs*. Three open tabs therefore consumed the whole pool, and every other request — including ones the server answered in 10 ms — waited tens of seconds in the browser's queue for a free connection. Measured with three tabs open: `/health` took a **14.7 s median** from inside a tab while answering in **11 ms** to a client outside the browser at the same instant; after the upgrade the same probe reads 12 ms. A WebSocket is not part of that HTTP pool, so upgrading is what releases it.

### Console Namespace (`/console`)

Interactive console via Socket.IO WebSocket connection.

**Client → Server:**
- `send_command` - Execute command (`{command: "infos"}`)

**Server → Client:**
- `console_status` - Connection status
- `command_response` - Command result (`{success, command, output}`)

### Chat Namespace (`/chat`)

Real-time message delivery via Socket.IO.

**Server → Client:**
- `new_channel_message` - New channel message received
- `new_dm_message` - New DM received
- `message_echo` - Echo/ACK update for sent message (includes `hash_size`)
- `dm_ack` - DM delivery confirmation
- `dm_retry_status` - Real-time retry progress (`dm_id`, `attempt`, `max_attempts`)
- `dm_retry_failed` - All retry attempts exhausted (`dm_id`)
- `dm_delivered_info` - Delivery details after ACK (`dm_id`, `attempt`, `max_attempts`, `path`, `hash_size`)
- `path_changed` - Contact path discovered/updated (`public_key`)
- `observer_status` - Observer live state (`enabled`, `running`, `reason`, packet counters, per-broker `connected`/`last_error`)

### Logs Namespace (`/logs`)

Real-time log streaming via Socket.IO.

**Server → Client:**
- `log_line` - New log line

The `MemoryLogHandler` filters werkzeug access-log records for `/socket.io/` and `/api/logs/` paths before buffering/broadcasting. Clients still open on long-polling before upgrading, and stay there wherever the upgrade is blocked; without this filter every poll is logged, the broadcast wakes the pending poll, the client re-polls immediately, and an open System Log tab spins at 10+ requests/sec.

---

## Versioning & Releases

Two identities, deliberately separate — `app/version.py` exposes both:

| | Source | Looks like | Used for |
|---|---|---|---|
| `RELEASE_VERSION` | `VERSION` file at the repo root | `2.1.0` | What users and testers quote; the git tag; the GitHub release |
| `VERSION_STRING` | git commit date + short hash | `2026.07.26+95d96ec` | Pinning down an exact deploy; what `/api/check-update` compares |

Resolution order is unchanged: `app/version_frozen.py` (written by `python -m app.version freeze`, which `scripts/update.sh` runs before every rebuild) wins over live git, which wins over the built-in fallbacks. `RELEASE_VERSION` is read from the `VERSION` file and only *overridden* by the frozen file, so a frozen file written before releases existed still yields a correct release number. The container has no git and no `.git`, hence `COPY VERSION ./` in the Dockerfile — without it a plain `docker compose build` would report `0.0.0`.

Both values ship in `GET /api/version` (`release` and `version`) and in the template context (`{{ release }}`, `{{ version }}`). The menu shows the release number first with the build underneath; `#versionText` deliberately still holds the *build* string, because the remote-update poller compares it to detect that the server came back on a new build.

**Cutting a release:**

1. On `dev`: bump `VERSION`, and title the pending `docs/whatsnew.md` section `## <version> — <date>` (open a fresh `## Unreleased` above it)
2. Merge `dev` → `main`
3. On `main`: `./scripts/release.sh` — validates the number, refuses a dirty tree, a non-`main` branch, or an existing tag, extracts the notes from that whatsnew section, then tags `v<version>`, pushes it, and publishes the GitHub release via `gh`. `--dry-run` prints the notes and changes nothing
4. Deploy as usual (`mcupdate`), which freezes the version into the image

Numbering is SemVer read through an operator's eyes: **MAJOR** when a deploy needs manual action (new env var, migration, breaking config), **MINOR** for new features, **PATCH** for fixes only. Releases start at 2.1.0 — the v2 line has been in production since 2026-03-28, and the pre-migration 1.x line preceded it, so 1.x would have been ambiguous. (The `v1` and `v2` archive branches were removed on 2026-08-03; both tips are ancestors of `main`, so that history is still reachable there.) Everything before 2.1.0 is dated but untagged.

---

## Offline Support

The application works completely offline without internet connection. Vendor libraries (Bootstrap, Bootstrap Icons, Socket.IO, Emoji Picker) are bundled locally. A Service Worker provides hybrid caching to ensure functionality without connectivity.
