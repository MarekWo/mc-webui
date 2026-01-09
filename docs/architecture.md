# mc-webui Architecture

Technical documentation for mc-webui, covering system architecture, project structure, and internal APIs.

## Table of Contents

- [Tech Stack](#tech-stack)
- [Container Architecture](#container-architecture)
- [Bridge Session Architecture](#bridge-session-architecture)
- [Project Structure](#project-structure)
- [Message File Format](#message-file-format)
- [API Reference](#api-reference)
- [Offline Support](#offline-support)

---

## Tech Stack

- **Backend:** Python 3.11+, Flask, Flask-SocketIO (gevent)
- **Frontend:** HTML5, Bootstrap 5, vanilla JavaScript, Socket.IO client
- **Deployment:** Docker / Docker Compose (2-container architecture)
- **Communication:** HTTP bridge to meshcore-cli, WebSocket for interactive console
- **Data source:** `~/.config/meshcore/<device_name>.msgs` (JSON Lines)

---

## Container Architecture

mc-webui uses a **2-container architecture** for improved USB stability:

```
┌─────────────────────────────────────────────────────────────┐
│                     Docker Network                           │
│                                                              │
│  ┌─────────────────────┐      ┌─────────────────────────┐  │
│  │   meshcore-bridge   │      │       mc-webui          │  │
│  │                     │      │                         │  │
│  │  - USB device access│ HTTP │  - Flask web app        │  │
│  │  - meshcli process  │◄────►│  - User interface       │  │
│  │  - Port 5001        │      │  - Port 5000            │  │
│  │                     │      │                         │  │
│  └─────────┬───────────┘      └─────────────────────────┘  │
│            │                                                 │
└────────────┼─────────────────────────────────────────────────┘
             │
             ▼
      ┌──────────────┐
      │  USB Device  │
      │  (Heltec V4) │
      └──────────────┘
```

### meshcore-bridge (Port 5001 - internal)

Lightweight service with exclusive USB device access:

- Maintains a **persistent meshcli session** (single long-lived process)
- Multiplexes stdout: JSON adverts → `.adverts.jsonl` log, CLI commands → HTTP responses
- Real-time message reception via `msgs_subscribe` (no polling)
- Thread-safe command queue with event-based synchronization
- Watchdog thread for automatic crash recovery
- Exposes HTTP API on port 5001 (internal only)

### mc-webui (Port 5000 - external)

Main web application:

- Flask-based web interface with Flask-SocketIO
- Communicates with bridge via HTTP API
- WebSocket support for interactive Console (`/console` namespace)
- No direct USB access (prevents device locking)

This separation solves USB timeout/deadlock issues common in Docker + VM environments.

---

## Bridge Session Architecture

The meshcore-bridge maintains a **single persistent meshcli session** instead of spawning new processes per request:

- **Single subprocess.Popen** - One long-lived meshcli process with stdin/stdout pipes
- **Multiplexing** - Intelligently routes output:
  - JSON adverts (with `payload_typename: "ADVERT"`) → logged to `{device_name}.adverts.jsonl`
  - CLI command responses → returned via HTTP API
- **Real-time messages** - `msgs_subscribe` command enables instant message reception without polling
- **Thread-safe queue** - Commands are serialized through a queue.Queue for FIFO execution
- **Timeout-based detection** - Response completion detected when no new lines arrive for 300ms
- **Auto-restart watchdog** - Monitors process health and restarts on crash

This architecture enables advanced features like pending contact management (`manual_add_contacts`) and provides better stability and performance.

---

## Project Structure

```
mc-webui/
├── Dockerfile                      # Main app Docker image
├── docker-compose.yml              # Multi-container orchestration
├── meshcore-bridge/
│   ├── Dockerfile                  # Bridge service image
│   ├── bridge.py                   # HTTP API wrapper for meshcli
│   └── requirements.txt            # Bridge dependencies (Flask only)
├── app/
│   ├── __init__.py
│   ├── main.py                     # Flask entry point
│   ├── config.py                   # Configuration from env vars
│   ├── read_status.py              # Server-side read status manager
│   ├── meshcore/
│   │   ├── __init__.py
│   │   ├── cli.py                  # HTTP client for bridge API
│   │   └── parser.py               # .msgs file parser
│   ├── archiver/
│   │   └── manager.py              # Archive scheduler and management
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── api.py                  # REST API endpoints
│   │   └── views.py                # HTML views
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css           # Custom styles
│   │   ├── js/
│   │   │   ├── app.js              # Main page frontend logic
│   │   │   ├── dm.js               # Direct Messages page logic
│   │   │   ├── contacts.js         # Contact Management logic
│   │   │   ├── console.js          # Interactive console WebSocket client
│   │   │   ├── message-utils.js    # Message content processing
│   │   │   └── sw.js               # Service Worker for PWA
│   │   ├── vendor/                 # Local vendor libraries (offline)
│   │   │   ├── bootstrap/          # Bootstrap CSS/JS
│   │   │   ├── bootstrap-icons/    # Icon fonts
│   │   │   ├── socket.io/          # Socket.IO client library
│   │   │   └── emoji-picker-element/
│   │   └── manifest.json           # PWA manifest
│   └── templates/
│       ├── base.html               # Base template
│       ├── index.html              # Main chat view
│       ├── dm.html                 # Direct Messages view
│       ├── console.html            # Interactive meshcli console
│       ├── contacts_base.html      # Contact pages base template
│       ├── contacts-manage.html    # Contact Management settings
│       ├── contacts-pending.html   # Pending contacts view
│       └── contacts-existing.html  # Existing contacts view
├── docs/                           # Documentation
├── images/                         # Screenshots and diagrams
├── requirements.txt                # Python dependencies
├── .env.example                    # Example environment config
└── README.md
```

---

## Message File Format

Location: `~/.config/meshcore/<device_name>.msgs` (JSON Lines)

### Message Types

**Channel messages:**
```json
{"type": "CHAN", "text": "User: message", "timestamp": 1766300846}
{"type": "SENT_CHAN", "text": "my message", "name": "DeviceName", "timestamp": 1766309432}
```

**Private messages:**
```json
{"type": "PRIV", "text": "message", "sender_timestamp": 1766300846, "pubkey_prefix": "abc123", "sender": "User"}
{"type": "SENT_MSG", "text": "message", "recipient": "User", "expected_ack": "xyz", "suggested_timeout": 30000}
```

**Note on SENT_MSG:** Requires meshcore-cli >= 1.3.12 for correct format with both `recipient` and `sender` fields.

---

## API Reference

### Main Web UI Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages` | List messages (supports `?archive_date`, `?days`, `?channel_idx`) |
| POST | `/api/messages` | Send message (`{text, channel_idx, reply_to?}`) |
| GET | `/api/messages/updates` | Check for new messages (smart refresh) |
| GET | `/api/status` | Connection status |
| GET | `/api/contacts` | List contacts |
| GET | `/api/contacts/detailed` | Full contact_info data |
| POST | `/api/contacts/delete` | Delete contact by name |
| GET | `/api/contacts/pending` | List pending contacts |
| POST | `/api/contacts/pending/approve` | Approve pending contact |
| POST | `/api/contacts/preview-cleanup` | Preview cleanup matches |
| POST | `/api/contacts/cleanup` | Execute contact cleanup |
| GET | `/api/channels` | List all channels |
| POST | `/api/channels` | Create new channel |
| POST | `/api/channels/join` | Join existing channel |
| DELETE | `/api/channels/<index>` | Remove channel |
| GET | `/api/channels/<index>/qr` | Generate QR code |
| GET | `/api/dm/conversations` | List DM conversations |
| GET | `/api/dm/messages` | Get messages for conversation |
| POST | `/api/dm/messages` | Send DM |
| GET | `/api/dm/updates` | Check for new DMs |
| GET | `/api/device/info` | Device information |
| GET | `/api/device/settings` | Get device settings |
| POST | `/api/device/settings` | Update device settings |
| POST | `/api/device/command` | Execute special command |
| GET | `/api/read_status` | Get server-side read status |
| POST | `/api/read_status/mark_read` | Mark messages as read |
| GET | `/api/archives` | List available archives |
| POST | `/api/archive/trigger` | Manually trigger archiving |

### WebSocket API (Console)

Interactive meshcli console via Socket.IO WebSocket connection.

**Namespace:** `/console`

| Event | Direction | Description |
|-------|-----------|-------------|
| `send_command` | Client → Server | Execute command (`{command: "infos"}`) |
| `console_status` | Server → Client | Connection status message |
| `command_response` | Server → Client | Command result (`{success, command, output}`) |

**Features:**
- Command history navigation (up/down arrows)
- Auto-reconnection on disconnect
- Output cleaning (removes prompts like "DeviceName|*")
- Slow command timeouts: `node_discover` (15s), `recv` (60s), `send` (15s)

### Bridge Internal API (Port 5001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/cli` | Execute meshcli command (`{args: ["cmd"], timeout?}`) |
| GET | `/health` | Bridge health check |
| GET | `/pending_contacts` | List pending contacts |
| POST | `/add_pending` | Approve pending contact |
| GET | `/device/settings` | Get device settings |
| POST | `/device/settings` | Update device settings |

**Base URL:** `http://meshcore-bridge:5001` (internal Docker network only)

---

## Offline Support

The application works completely offline without internet connection - perfect for mesh networks in remote or emergency scenarios.

### Local Vendor Libraries

| Library | Size | Location |
|---------|------|----------|
| Bootstrap 5.3.2 CSS | ~227 KB | `static/vendor/bootstrap/css/` |
| Bootstrap 5.3.2 JS | ~80 KB | `static/vendor/bootstrap/js/` |
| Bootstrap Icons 1.11.2 | ~398 KB | `static/vendor/bootstrap-icons/` |
| Emoji Picker Element | ~529 KB | `static/vendor/emoji-picker-element/` |

**Total offline package size:** ~1.2 MB

### Service Worker Caching

- **Cache version:** `mc-webui-v3`
- **Strategy:** Hybrid caching
  - **Cache-first** for vendor libraries (static, unchanging)
  - **Network-first** for app code (dynamic, needs updates)

### How It Works

1. On first visit (online), Service Worker installs and caches all assets
2. Vendor libraries (Bootstrap, Icons, Emoji Picker) loaded from cache instantly
3. App code checks network first, falls back to cache if offline
4. Complete UI functionality available offline
5. Only API calls (messages, channels, contacts) require connectivity

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MC_SERIAL_PORT` | Serial device path | - |
| `MC_DEVICE_NAME` | Device name (for files) | - |
| `MC_CONFIG_DIR` | Configuration directory | `./data/meshcore` |
| `MC_ARCHIVE_DIR` | Archive directory | `./data/archive` |
| `MC_ARCHIVE_ENABLED` | Enable automatic archiving | `true` |
| `MC_ARCHIVE_RETENTION_DAYS` | Days to show in live view | `7` |
| `FLASK_HOST` | Listen address | `0.0.0.0` |
| `FLASK_PORT` | Web server port | `5000` |
| `FLASK_DEBUG` | Debug mode | `false` |
| `TZ` | Timezone for logs | `UTC` |

---

## Persistent Settings

### Settings File

**Location:** `MC_CONFIG_DIR/.webui_settings.json`

```json
{
  "manual_add_contacts": false
}
```

### Read Status File

**Location:** `MC_CONFIG_DIR/.read_status.json`

Stores per-channel and per-conversation read timestamps for cross-device synchronization.

```json
{
  "channels": {"0": 1735900000, "1": 1735900100},
  "dm": {"name_User1": 1735900200}
}
```

---

## Related Documentation

- [User Guide](user-guide.md) - How to use all features
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [Docker Installation](docker-install.md) - How to install Docker
