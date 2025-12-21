# mc-webui

A lightweight web interface for meshcore-cli, providing browser-based access to MeshCore mesh network.

## Overview

**mc-webui** is a Flask-based web application that wraps `meshcore-cli`, eliminating the need for SSH/terminal access when using MeshCore chat on a Heltec V4 device connected to a Debian VM.

### Key Features (MVP)

- 📱 **View messages** - Display chat history from Public channel with auto-refresh
- ✉️ **Send messages** - Publish to Public channel
- 💬 **Reply to users** - Quick reply with `@[UserName]` format
- 🧹 **Clean contacts** - Remove inactive contacts with configurable threshold

## Tech Stack

- **Backend:** Python 3.11+, Flask
- **Frontend:** HTML5, Bootstrap 5, vanilla JavaScript
- **Deployment:** Docker / Docker Compose
- **Communication:** subprocess calls to `meshcli`
- **Data source:** `~/.config/meshcore/<device_name>.msgs` (JSON Lines)

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Heltec V4 device connected via USB
- meshcore-cli configured on host system

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
   cd docker
   docker-compose up -d
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
| `FLASK_HOST` | Listen address | `0.0.0.0` |
| `FLASK_PORT` | Application port | `5000` |
| `FLASK_DEBUG` | Debug mode | `false` |

See [.env.example](.env.example) for a complete example.

## Project Structure

```
mc-webui/
├── docker/
│   ├── Dockerfile              # Docker image definition
│   └── docker-compose.yml      # Docker Compose configuration
├── app/
│   ├── __init__.py
│   ├── main.py                 # Flask entry point
│   ├── config.py               # Configuration from env vars
│   ├── meshcore/
│   │   ├── __init__.py
│   │   ├── cli.py              # meshcli wrapper (subprocess)
│   │   └── parser.py           # .msgs file parser
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── api.py              # REST API endpoints
│   │   └── views.py            # HTML views
│   ├── static/
│   │   ├── css/
│   │   │   └── style.css       # Custom styles
│   │   └── js/
│   │       └── app.js          # Frontend logic
│   └── templates/
│       ├── base.html           # Base template
│       ├── index.html          # Main chat view
│       └── components/         # Reusable components
├── requirements.txt            # Python dependencies
├── .env.example               # Example environment config
├── .gitignore
├── README.md                  # This file
└── PRD.md                     # Product Requirements Document
```

## Development Status

🚧 **Current Phase: 0 - Environment Setup** ✅

### Roadmap

- [x] Phase 0: Environment Setup
- [ ] Phase 1: Backend Basics
- [ ] Phase 2: Frontend Chat View
- [ ] Phase 3: Message Sending
- [ ] Phase 4: Auto-refresh
- [ ] Phase 5: Contact Management
- [ ] Phase 6: Polish & Documentation

See [PRD.md](PRD.md) for detailed requirements and implementation plan.

## Usage

### Viewing Messages

The main page displays chat history from the Public channel (channel 0). Messages auto-refresh every 60 seconds by default.

### Sending Messages

1. Type your message in the text field at the bottom
2. Press Enter or click "Send"
3. Your message will be published to the Public channel

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
cd docker
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the application
docker-compose down

# Rebuild after code changes
docker-compose up -d --build

# Check container status
docker-compose ps
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
# Check logs
docker-compose logs mc-webui

# Verify .env file exists
ls -la ../.env

# Check if port 5000 is available
sudo netstat -tulpn | grep 5000
```

### Messages not updating
- Ensure meshcore-cli is properly configured
- Check that `.msgs` file exists in `MC_CONFIG_DIR`
- Verify serial device is accessible from container

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

---

**Target Deployment:** Debian VM @ 192.168.131.80
**Hardware:** Heltec WiFi LoRa 32 V4
