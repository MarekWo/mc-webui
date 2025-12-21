# mc-webui: Initial Prompt for Claude Code

## Project Context

You are continuing development of **mc-webui** - a lightweight web interface for meshcore-cli. This project was designed collaboratively with Claude (Opus) and documented in PRD.md.

## Project Summary

**What:** A Flask-based web UI that wraps meshcore-cli, providing browser access to MeshCore mesh network.

**Why:** To eliminate the need for SSH/terminal access when using MeshCore chat on a Heltec V4 device connected to a Debian VM.

**Target:** Single-user, trusted local network, Docker deployment.

## Technical Stack

- **Backend:** Python 3.11+, Flask
- **Frontend:** HTML5, Bootstrap 5, vanilla JavaScript
- **Deployment:** Docker / Docker Compose
- **Communication:** subprocess calls to `meshcli`
- **Data source:** `~/.config/meshcore/<device_name>.msgs` (JSON Lines)

## MVP Features

1. **View messages** - display chat history from Public channel (auto-refresh every 60s)
2. **Send messages** - publish to Public channel
3. **Reply to users** - `@[UserName] content` format
4. **Clean contacts** - remove inactive contacts (configurable hours threshold)

## Key Files to Create

```
mc-webui/
├── Dockerfile
├── docker-compose.yml
├── app/
│   ├── __init__.py
│   ├── main.py              # Flask entry point
│   ├── config.py            # Configuration from env vars
│   ├── meshcore/
│   │   ├── __init__.py
│   │   ├── cli.py           # meshcli wrapper (subprocess)
│   │   └── parser.py        # .msgs file parser
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── api.py           # REST API endpoints
│   │   └── views.py         # HTML views
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css
│   │   └── js/
│   │       └── app.js
│   └── templates/
│       ├── base.html
│       ├── index.html
│       └── components/
│           ├── message.html
│           └── navbar.html
├── requirements.txt
├── .env.example
├── .gitignore
├── README.md
└── PRD.md                   # Already created - see attached
```

## Environment Variables

```env
MC_SERIAL_PORT=/dev/serial/by-id/usb-Espressif_Systems_heltec_wifi_lora_32_v4__16_MB_FLASH__2_MB_PSRAM__90706984A000-if00
MC_DEVICE_NAME=MarWoj
MC_CONFIG_DIR=/root/.config/meshcore
MC_REFRESH_INTERVAL=60
MC_INACTIVE_HOURS=48
FLASK_HOST=0.0.0.0
FLASK_PORT=5000
FLASK_DEBUG=false
```

## meshcli Commands Reference

```bash
# Base command (alias 'mc' exists on host)
meshcli -s <SERIAL_PORT> <command>

# Sync/fetch messages
meshcli -s <PORT> recv

# Send to Public channel
meshcli -s <PORT> public "message text"

# Reply to user (still goes to Public)
meshcli -s <PORT> public "@[UserName] message text"

# Get contact list
meshcli -s <PORT> contacts

# Clean inactive contacts (type=1 is client, u<48h = updated less than 48h ago)
meshcli -s <PORT> "apply_to u<48h,t=1 remove_contact"

# Device info
meshcli -s <PORT> infos
```

## Message Format (.msgs file - JSON Lines)

```json
// Received message
{"type": "CHAN", "SNR": 10.5, "channel_idx": 0, "path_len": 5, "txt_type": 0, "sender_timestamp": 1766300840, "text": "UserName🤖: Hello everyone", "name": "channel 0", "timestamp": 1766300846}

// Sent message
{"type": "SENT_CHAN", "channel_idx": 0, "text": "My message", "txt_type": 0, "name": "MarWoj", "timestamp": 1766309432}
```

**Key fields:**
- `type`: "CHAN" (received) or "SENT_CHAN" (sent)
- `text`: For received - includes "SenderName: message", for sent - just the message
- `timestamp`: Unix timestamp
- `channel_idx`: 0 = Public channel
- `name`: For sent messages - sender's device name

## API Endpoints (to implement)

```
GET  /api/messages          # List messages (optional: ?limit=100&offset=0)
POST /api/messages          # Send message {"text": "...", "reply_to": "UserName" (optional)}
GET  /api/status            # Device/connection status
POST /api/contacts/cleanup  # Clean inactive contacts {"hours": 48}
GET  /api/device/info       # Device information
```

## Implementation Order (Phases)

### Phase 0: Environment Setup
- Create directory structure
- Dockerfile (Python 3.11, install meshcore-cli via pip)
- docker-compose.yml (mount serial device, mount .config/meshcore)
- .env.example, .gitignore
- Basic README.md

### Phase 1: Backend Basics
- Flask app skeleton
- config.py (load from environment)
- meshcore/cli.py (subprocess wrapper with timeout handling)
- meshcore/parser.py (read and parse .msgs file)
- Basic API endpoints

### Phase 2: Frontend Chat View
- base.html (Bootstrap 5 CDN)
- index.html (chat layout)
- Message list with own/others distinction
- Time formatting (relative or absolute)

### Phase 3: Message Sending
- Send form with validation
- Toast notifications for feedback
- Reply button functionality

### Phase 4: Auto-refresh
- JavaScript polling every 60s
- Last refresh indicator
- Manual refresh button
- Smart scroll (don't interrupt user scrolling)

### Phase 5: Contact Management
- Settings modal
- Cleanup function with confirmation
- Result feedback

### Phase 6: Polish
- Error handling
- Loading states
- README with full documentation
- Docker image optimization

## Important Notes

1. **All code, comments, and documentation must be in English** (open source project)
2. **Keep it simple** - this is MVP, avoid over-engineering
3. **Error handling** - meshcli can timeout or fail, handle gracefully
4. **No authentication** - trusted network assumption
5. **Test with real device** - the Heltec V4 is connected via USB to this VM

## Current State

- PRD.md is complete and attached/available
- No code has been written yet
- Development environment: VS Code Remote SSH to Debian VM
- Docker not yet installed on VM (will install when needed)

## First Task

Start with **Phase 0: Environment Setup**:
1. Create the directory structure
2. Create Dockerfile
3. Create docker-compose.yml
4. Create .env.example
5. Create .gitignore
6. Create initial README.md

Then proceed to Phase 1 when ready.

---

## Reference: Full PRD

The complete PRD.md document is available in this repository. It contains:
- Detailed requirements (functional and non-functional)
- UI wireframes
- Architecture diagrams
- Risk analysis
- Future roadmap

Please refer to PRD.md for any detailed specifications.