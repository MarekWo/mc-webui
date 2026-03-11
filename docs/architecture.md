# mc-webui Architecture

Technical documentation for mc-webui, covering system architecture, project structure, and internal APIs.

## Table of Contents

- [Tech Stack](#tech-stack)
- [Container Architecture](#container-architecture)
- [DeviceManager Architecture](#devicemanager-architecture)
- [Project Structure](#project-structure)
- [Database Architecture](#database-architecture)
- [API Reference](#api-reference)
- [Offline Support](#offline-support)

---

## Tech Stack

- **Backend:** Python 3.11+, Flask, Flask-SocketIO (gevent), SQLite
- **Frontend:** HTML5, Bootstrap 5, vanilla JavaScript, Socket.IO client
- **Deployment:** Docker / Docker Compose (Single-container architecture)
- **Communication:** Direct hardware access (USB, BLE, or TCP) via `meshcore` library
- **Data source:** SQLite Database (`./data/meshcore/<device_name>.db`)

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
│  │  - DeviceManager (Direct USB/TCP access)              │   │
│  │  - Database (SQLite)                                  │   │
│  │                                                       │   │
│  └─────────┬─────────────────────────────────────────────┘   │
│            │                                                 │
└────────────┼─────────────────────────────────────────────────┘
             │
             ▼
      ┌──────────────┐
      │  USB/TCP     │
      │  Device      │
      └──────────────┘
```

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
│   ├── main.py                     # Flask entry point + Socket.IO
│   ├── config.py                   # Configuration from env vars
│   ├── database.py                 # SQLite database models and CRUD operations
│   ├── device_manager.py           # Core logic for meshcore communication
│   ├── read_status.py              # Server-side read status manager
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
├── scripts/                        # Utility scripts (update, watchdog, etc.)
└── README.md
```

---

## Database Architecture

mc-webui v2 uses a robust **SQLite Database** with WAL (Write-Ahead Logging) enabled.

Location: `./data/meshcore/<device_name>.db`

Key tables:
- `messages` - All channel and direct messages
- `contacts` - Contact list with sync status, types, block/ignore flags
- `channels` - Channel configuration and keys
- `echoes` - Sent message tracking and repeater paths
- `acks` - DM delivery status

The use of SQLite allows for fast queries, reliable data storage, and complex filtering (such as contact ignoring/blocking) without the risk of file corruption inherent to flat JSON files.

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
| GET | `/api/contacts/detailed` | Full contact data |
| POST | `/api/contacts/delete` | Soft-delete contact by name |
| POST | `/api/contacts/update` | Update contact properties (ignore, block) |
| GET | `/api/channels` | List all channels |
| POST | `/api/channels` | Create new channel |
| POST | `/api/channels/join` | Join existing channel |
| DELETE | `/api/channels/<index>` | Remove channel |
| GET | `/api/dm/conversations` | List DM conversations |
| GET | `/api/dm/messages` | Get messages for conversation |
| POST | `/api/dm/messages` | Send DM |
| GET | `/api/device/info` | Device information |
| GET | `/api/read_status` | Get server-side read status |

### WebSocket API (Console)

Interactive console via Socket.IO WebSocket connection.

**Namespace:** `/console`

---

## Offline Support

The application works completely offline without internet connection. Vendor libraries (Bootstrap, Bootstrap Icons, Socket.IO, Emoji Picker) are bundled locally. A Service Worker provides hybrid caching to ensure functionality without connectivity.
