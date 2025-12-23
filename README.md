# mc-webui

A lightweight web interface for meshcore-cli, providing browser-based access to MeshCore mesh network.

## Overview

**mc-webui** is a Flask-based web application that wraps `meshcore-cli`, eliminating the need for SSH/terminal access when using MeshCore chat on a Heltec V4 device connected to a Debian VM.

![Main Chat Window](images/main_window.png) ![Channel management](images/channel_management.png) ![Settings](images/settings.png)

### Key Features

- 📱 **View messages** - Display chat history with auto-refresh
- ✉️ **Send messages** - Publish to any channel (200 char limit for LoRa)
- 📡 **Channel management** - Create, join, and switch between encrypted channels
- 🔐 **Channel sharing** - Share channels via QR code or encrypted keys
- 💬 **Reply to users** - Quick reply with `@[UserName]` format
- 🧹 **Clean contacts** - Remove inactive contacts with configurable threshold
- 📦 **Message archiving** - Automatic daily archiving with browse-by-date selector

## Tech Stack

- **Backend:** Python 3.11+, Flask
- **Frontend:** HTML5, Bootstrap 5, vanilla JavaScript
- **Deployment:** Docker / Docker Compose (2-container architecture)
- **Communication:** HTTP bridge to meshcore-cli (USB isolation for stability)
- **Data source:** `~/.config/meshcore/<device_name>.msgs` (JSON Lines)

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Heltec V4 device connected via USB

**Note:** meshcore-cli is automatically installed inside the Docker container - no host installation required!

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd mc-webui
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   nano .env
   ```

3. **Find your serial device**
   ```bash
   ls -l /dev/serial/by-id/
   ```
   Update `MC_SERIAL_PORT` in `.env` with your device path.

4. **Build and run**
   ```bash
   docker compose up -d --build
   ```

5. **Access the web interface**
   Open your browser and navigate to:
   ```
   http://localhost:5000
   ```
   Or from another device on your network:
   ```
   http://<server-ip>:5000
   ```

## Configuration

All configuration is done via environment variables in the `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `MC_SERIAL_PORT` | Path to serial device | `/dev/ttyUSB0` |
| `MC_DEVICE_NAME` | Device name (for .msgs file) | `MeshCore` |
| `MC_CONFIG_DIR` | meshcore configuration directory | `/root/.config/meshcore` |
| `MC_REFRESH_INTERVAL` | Auto-refresh interval (seconds) | `60` |
| `MC_INACTIVE_HOURS` | Inactivity threshold for cleanup | `48` |
| `MC_ARCHIVE_DIR` | Archive directory path | `/mnt/archive/meshcore` |
| `MC_ARCHIVE_ENABLED` | Enable automatic archiving | `true` |
| `MC_ARCHIVE_RETENTION_DAYS` | Days to show in live view | `7` |
| `FLASK_HOST` | Listen address | `0.0.0.0` |
| `FLASK_PORT` | Application port | `5000` |
| `FLASK_DEBUG` | Debug mode | `false` |

See [.env.example](.env.example) for a complete example.

## Architecture

mc-webui uses a **2-container architecture** for improved USB stability:

1. **meshcore-bridge** - Lightweight service with exclusive USB device access
   - Runs meshcore-cli subprocess calls
   - Exposes HTTP API on port 5001 (internal only)
   - Automatically restarts on USB communication issues

2. **mc-webui** - Main web application
   - Flask-based web interface
   - Communicates with bridge via HTTP
   - No direct USB access (prevents device locking)

This separation solves USB timeout/deadlock issues common in Docker + VM environments.

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
│   ├── meshcore/
│   │   ├── __init__.py
│   │   ├── cli.py                  # HTTP client for bridge API
│   │   └── parser.py               # .msgs file parser
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── api.py                  # REST API endpoints
│   │   └── views.py                # HTML views
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css           # Custom styles
│   │   └── js/
│   │       └── app.js              # Frontend logic
│   └── templates/
│       ├── base.html               # Base template
│       ├── index.html              # Main chat view
│       └── components/             # Reusable components
├── requirements.txt                # Python dependencies
├── .env.example                   # Example environment config
├── .gitignore
├── README.md                      # This file
└── PRD.md                         # Product Requirements Document
```

## Development Status

🚧 **Current Phase: 1 - Backend Basics** ✅

### Roadmap

- [x] Phase 0: Environment Setup
- [x] Phase 1: Backend Basics (REST API, message parsing, CLI wrapper)
- [x] Phase 2: Frontend Chat View (Bootstrap UI, message display)
- [x] Phase 3: Message Sending (Send form, reply functionality)
- [x] Phase 4: Auto-refresh (60s polling, live updates)
- [x] Phase 5: Contact Management (Cleanup modal)
- [ ] Phase 6: Polish & Documentation (Testing, optimization)

See [PRD.md](PRD.md) for detailed requirements and implementation plan.

## Usage

### Viewing Messages

The main page displays chat history from the currently selected channel. Messages auto-refresh every 60 seconds by default.

By default, the live view shows messages from the last 7 days. Older messages are automatically archived and can be accessed via the date selector.

### Managing Channels

Access channel management by clicking the broadcast icon (📡) in the navbar:

#### Creating a New Channel
1. Click "Add New Channel"
2. Enter a channel name (letters, numbers, _ and - only)
3. Click "Create & Auto-generate Key"
4. The channel is created with a secure encryption key

#### Sharing a Channel
1. In the Channels modal, click the share icon next to any channel
2. Share the QR code (scan with another device) or copy the encryption key
3. Others can join using the "Join Existing" option

#### Joining a Channel
1. Click "Join Existing"
2. Enter the channel name and encryption key (received from channel creator)
3. Click "Join Channel"
4. The channel will be added to your available channels

#### Switching Channels
Use the channel selector dropdown in the navbar to switch between channels. Your selection is remembered between sessions.

### Viewing Message Archives

Access historical messages using the date selector in the navbar:

1. Click the date dropdown in the navbar
2. Select a date to view archived messages for that day
3. Select "Today (Live)" to return to live view

Archives are created automatically at midnight (00:00 UTC) each day. The live view always shows the most recent messages (last 7 days by default).

### Sending Messages

1. Select your target channel using the channel selector
2. Type your message in the text field at the bottom
3. Press Enter or click "Send"
4. Your message will be published to the selected channel

### Replying to Users

Click the reply button on any message to insert `@[UserName]` into the text field, then type your reply.

### Managing Contacts

Access the settings panel to clean up inactive contacts:
1. Click the settings icon
2. Adjust the inactivity threshold (default: 48 hours)
3. Click "Clean Inactive Contacts"
4. Confirm the action

## Docker Commands

```bash
# Start the application
docker compose up -d

# View logs
docker compose logs -f

# Stop the application
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Check container status
docker compose ps
```

## Troubleshooting

### Device not found
```bash
# Check if device is connected
ls -l /dev/serial/by-id/

# Verify device permissions
sudo chmod 666 /dev/serial/by-id/usb-Espressif*
```

### Container won't start
```bash
# Check logs for both services
docker compose logs meshcore-bridge
docker compose logs mc-webui

# Verify .env file exists
ls -la .env

# Check if ports are available
sudo netstat -tulpn | grep -E '5000|5001'
```

### USB Communication Issues
The 2-container architecture resolves common USB timeout/deadlock problems:
- **meshcore-bridge** has exclusive USB access
- **mc-webui** uses HTTP (no direct device access)
- Restarting `mc-webui` **does not** affect USB connection
- If bridge has USB issues, restart only that service:
  ```bash
  docker compose restart meshcore-bridge
  ```

### Bridge connection errors
```bash
# Check bridge health
docker compose exec mc-webui curl http://meshcore-bridge:5001/health

# Bridge logs
docker compose logs -f meshcore-bridge

# Test meshcli directly in bridge container
docker compose exec meshcore-bridge meshcli -s /dev/ttyUSB0 infos
```

### Messages not updating
- Check that `.msgs` file exists in `MC_CONFIG_DIR`
- Verify bridge service is healthy: `docker compose ps`
- Check bridge logs for command errors

## Security Notes

⚠️ **Important**: This application is designed for **trusted local networks only** and has **no authentication**. Do not expose it to the internet without implementing proper security measures.

## Contributing

This is an open-source project. Contributions are welcome!

- All code, comments, and documentation must be in English
- Follow the existing code style
- Test your changes with real hardware if possible

## License

[License TBD]

## References

- [MeshCore Documentation](https://meshcore.org)
- [meshcore-cli GitHub](https://github.com/meshcore/meshcore-cli)
- [Product Requirements Document](PRD.md)


