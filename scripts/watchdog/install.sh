#!/bin/bash
#
# mc-webui Container Watchdog Installer
#
# This script installs the watchdog service that monitors Docker containers
# and automatically restarts unhealthy ones.
#
# Two ways to run it:
#
#   From a git checkout:
#     sudo ./install.sh
#
#   Without the repository (Docker Hub installations) - run this from the
#   folder holding your docker-compose.yml, it downloads what it needs:
#     curl -fsSL https://raw.githubusercontent.com/MarekWo/mc-webui/main/scripts/watchdog/install.sh | sudo bash
#
# Uninstall:
#     sudo ./install.sh --uninstall
#     curl -fsSL <same url> | sudo bash -s -- --uninstall
#
# Environment:
#   MCWEBUI_DIR - your mc-webui folder, if it cannot be found automatically
#   MC_BRANCH   - branch to download from in standalone mode (default: main)
#   MC_RAW_BASE - download from somewhere else entirely (fork or mirror)
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    error "Please run as root: sudo $0"
fi

SERVICE_NAME="mc-webui-watchdog"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LOG_FILE="/var/log/mc-webui-watchdog.log"
STANDALONE_DIR="/opt/mc-webui-watchdog"
MC_BRANCH="${MC_BRANCH:-main}"
# MC_RAW_BASE lets a fork, a mirror, or a test run point the download
# somewhere other than this repository.
RAW_BASE="${MC_RAW_BASE:-https://raw.githubusercontent.com/MarekWo/mc-webui/${MC_BRANCH}/scripts/watchdog}"

# Uninstall
if [ "$1" == "--uninstall" ]; then
    info "Uninstalling ${SERVICE_NAME}..."

    if systemctl is-active --quiet "$SERVICE_NAME"; then
        systemctl stop "$SERVICE_NAME"
        info "Service stopped"
    fi

    if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
        systemctl disable "$SERVICE_NAME"
        info "Service disabled"
    fi

    if [ -f "$SERVICE_FILE" ]; then
        rm "$SERVICE_FILE"
        systemctl daemon-reload
        info "Service file removed"
    fi

    # Only ever created by a standalone install, so it is safe to remove.
    # A repository install keeps its scripts where the checkout has them.
    if [ -d "$STANDALONE_DIR" ]; then
        rm -rf "$STANDALONE_DIR"
        info "Removed $STANDALONE_DIR"
    fi

    echo -e "${GREEN}Uninstallation complete!${NC}"
    echo ""
    echo "Note: Log file preserved at: $LOG_FILE"
    echo "To remove logs: sudo rm $LOG_FILE"
    exit 0
fi

# ---------------------------------------------------------------------------
# Where are we running from, and what are we watching?
# ---------------------------------------------------------------------------

# Piped through bash (curl | sudo bash) leaves BASH_SOURCE pointing at stdin,
# so the presence of watchdog.py next to us is what tells the two apart.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Find the folder holding docker-compose.yml - that is the mc-webui instance
find_instance_dir() {
    local candidates=("$@")
    local d
    for d in "${candidates[@]}"; do
        [ -n "$d" ] || continue
        if [ -f "$d/docker-compose.yml" ] || [ -f "$d/docker-compose.yaml" ]; then
            (cd "$d" && pwd)
            return 0
        fi
    done
    return 1
}

fetch() {  # fetch <url> <destination>
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
    else
        error "Neither curl nor wget is available - cannot download $1"
    fi
}

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/watchdog.py" ]; then
    # Repository install: run the script straight out of the checkout, so it
    # stays in step with the rest of the code on every git pull.
    INSTALL_MODE="repository"
    SCRIPT_DIR="$SELF_DIR"
    MCWEBUI_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
else
    INSTALL_MODE="standalone"
    SCRIPT_DIR="$STANDALONE_DIR"

    # $HOME is root's under sudo, so the invoking user's home is the one worth
    # looking in - that is where the README tells people to put mc-webui.
    SUDO_HOME=""
    if [ -n "${SUDO_USER:-}" ]; then
        SUDO_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    fi

    MCWEBUI_DIR="$(find_instance_dir \
        "${MCWEBUI_DIR:-}" \
        "$(pwd)" \
        "${SUDO_HOME:+$SUDO_HOME/mc-webui}" \
        "$HOME/mc-webui" \
        "/opt/mc-webui")" || error \
        "Cannot find your mc-webui folder (no docker-compose.yml). Run this from that folder, or set MCWEBUI_DIR=/path/to/mc-webui."
fi

# Install
info "Installing ${SERVICE_NAME}..."
info "  Install mode: $INSTALL_MODE"
info "  mc-webui directory: $MCWEBUI_DIR"

if [ "$INSTALL_MODE" == "standalone" ]; then
    info "  Downloading from branch: $MC_BRANCH"
    mkdir -p "$SCRIPT_DIR"

    # Into a temp file first, so a failed download cannot truncate a working
    # install of the service that is running right now.
    tmp="$(mktemp)"
    fetch "$RAW_BASE/watchdog.py" "$tmp" || error "Failed to download watchdog.py from $RAW_BASE"
    [ -s "$tmp" ] || error "Downloaded watchdog.py is empty"
    mv "$tmp" "$SCRIPT_DIR/watchdog.py"
    chmod 644 "$SCRIPT_DIR/watchdog.py"
    info "  Downloaded watchdog.py"
fi

# Check if watchdog.py exists
if [ ! -f "$SCRIPT_DIR/watchdog.py" ]; then
    error "watchdog.py not found in $SCRIPT_DIR"
fi

# Check if docker is available
if ! command -v docker &> /dev/null; then
    error "Docker is not installed or not in PATH"
fi

# The watchdog drives 'docker compose' inside this folder, so a compose file
# has to be there - a git checkout without one is no use to it either.
if [ ! -f "$MCWEBUI_DIR/docker-compose.yml" ] && [ ! -f "$MCWEBUI_DIR/docker-compose.yaml" ]; then
    error "No docker-compose.yml in $MCWEBUI_DIR - set MCWEBUI_DIR to your mc-webui folder"
fi

# Create log file with proper permissions
if [ ! -f "$LOG_FILE" ]; then
    touch "$LOG_FILE"
    chmod 644 "$LOG_FILE"
    info "Created log file: $LOG_FILE"
fi

# Create service file with correct paths
info "Creating systemd service file..."
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=mc-webui Container Watchdog
Documentation=https://github.com/MarekWo/mc-webui
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
Environment=MCWEBUI_DIR=${MCWEBUI_DIR}
Environment=CHECK_INTERVAL=30
Environment=LOG_FILE=${LOG_FILE}
Environment=HTTP_PORT=5051
Environment=AUTO_START=true
Environment=USB_DEVICE_PATH=${USB_DEVICE_PATH}
ExecStart=/usr/bin/python3 -u ${SCRIPT_DIR}/watchdog.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

info "Reloading systemd..."
systemctl daemon-reload

info "Enabling service..."
systemctl enable "$SERVICE_NAME"

# restart, not start: re-running the installer is how you upgrade a
# standalone install, and a running service would otherwise keep the old code
info "Starting service..."
systemctl restart "$SERVICE_NAME"

# Wait a moment for service to start
sleep 3

# Check if service is running
if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "Service is running!"

    # Test health endpoint
    if command -v curl &> /dev/null; then
        HEALTH=$(curl -s http://127.0.0.1:5051/health 2>/dev/null || echo "")
        if echo "$HEALTH" | grep -q '"status": *"ok"'; then
            info "Health check passed!"
        else
            warn "Health check failed - service may still be starting"
        fi
    fi
else
    error "Service failed to start. Check: journalctl -u $SERVICE_NAME"
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "The watchdog is now monitoring your containers."
echo ""
echo "Features:"
echo "  - Checks container health every 30 seconds"
echo "  - Automatically restarts unhealthy containers"
echo "  - Saves diagnostic logs before restart"
echo "  - Performs hardware USB bus reset if LoRa device is stuck"
echo ""
echo "Useful commands:"
echo "  systemctl status $SERVICE_NAME        # Check service status"
echo "  sudo journalctl -u $SERVICE_NAME -f   # View service logs"
echo "  tail -f $LOG_FILE                     # View watchdog logs"
echo "  curl http://localhost:5051/status     # Check container status"
echo "  curl http://localhost:5051/history    # View restart history"
if [ "$INSTALL_MODE" == "standalone" ]; then
    echo "  curl -fsSL $RAW_BASE/install.sh | sudo bash -s -- --uninstall"
else
    echo "  sudo $0 --uninstall                   # Uninstall"
fi
echo ""
echo "Diagnostic files are saved to /tmp/mc-webui-watchdog-*.log"
