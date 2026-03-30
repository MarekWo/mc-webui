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

---

## DeviceManager Architecture

The `DeviceManager` handles the connection to the MeshCore device via a direct session:

- **Single persistent session** - One long-lived connection utilizing the `meshcore` library
- **Event-driven** - Subscribes to device events (e.g., incoming messages, advert receptions, ACKs) and triggers appropriate handlers
- **Direct Database integration** - Seamlessly syncs contacts, messages, and device settings to the SQLite database
- **Real-time messages** - Instant message processing via callback events without polling
- **Thread-safe queue** - Commands are serialized to prevent device lockups
- **Auto-restart watchdog** - Monitors connection health and restarts the session on crash

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
│   └── templates/                  # HTML templates
├── docs/                           # Documentation
├── scripts/                        # Utility scripts (update, watchdog, updater)
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

The use of SQLite allows for fast queries, reliable data storage, full-text search, and complex filtering (such as contact ignoring/blocking) without the risk of file corruption inherent to flat JSON files.

---

## API Reference

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages` | List messages (`?archive_date`, `?days`, `?channel_idx`) |
| POST | `/api/messages` | Send message (`{text, channel_idx, reply_to?}`) |
| GET | `/api/messages/updates` | Check for new messages (smart refresh) |
| GET | `/api/messages/<id>/meta` | Get message metadata (echoes, paths) |
| GET | `/api/messages/search` | Full-text search (`?q=`, `?channel_idx=`, `?limit=`) |

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
| POST | `/api/contacts/<key>/paths/reset_flood` | Reset to FLOOD routing |
| POST | `/api/contacts/<key>/paths/clear` | Clear all paths |
| GET | `/api/contacts/<key>/no_auto_flood` | Get "Keep path" flag |
| PUT | `/api/contacts/<key>/no_auto_flood` | Set "Keep path" flag |

### Channels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List all channels |
| POST | `/api/channels` | Create new channel |
| POST | `/api/channels/join` | Join existing channel |
| DELETE | `/api/channels/<index>` | Remove channel |
| GET | `/api/channels/<index>/qr` | QR code (`?format=json\|png`) |
| GET | `/api/channels/muted` | Get muted channels |
| POST | `/api/channels/<index>/mute` | Toggle channel mute |

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
| GET | `/api/status` | Connection status (device name, transport type, serial port / BLE address) |
| GET | `/api/device/info` | Device information |
| GET | `/api/device/stats` | Device statistics |
| GET | `/api/device/settings` | Get device settings |
| POST | `/api/device/settings` | Update device settings |
| POST | `/api/device/command` | Execute command (advert, floodadv) |
| GET | `/api/device/commands` | List available special commands |
| GET | `/api/chat/settings` | Get chat settings (quote length) |
| POST | `/api/chat/settings` | Update chat settings |
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
| GET | `/api/logs` | Get application logs |

---

## WebSocket API

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

### Logs Namespace (`/logs`)

Real-time log streaming via Socket.IO.

**Server → Client:**
- `log_line` - New log line

---

## Offline Support

The application works completely offline without internet connection. Vendor libraries (Bootstrap, Bootstrap Icons, Socket.IO, Emoji Picker) are bundled locally. A Service Worker provides hybrid caching to ensure functionality without connectivity.
