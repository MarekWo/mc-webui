#!/bin/bash
#
# mc-webui Update Webhook Installer
#
# This script installs the update webhook service that allows
# remote updates from the mc-webui GUI.
#
# Usage: sudo ./install.sh [--uninstall]
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

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCWEBUI_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Detect the user who owns mc-webui directory
MCWEBUI_USER=$(stat -c '%U' "$MCWEBUI_DIR")
MCWEBUI_GROUP=$(stat -c '%G' "$MCWEBUI_DIR")

SERVICE_NAME="mc-webui-updater"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

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

    echo -e "${GREEN}Uninstallation complete!${NC}"
    exit 0
fi

# Install
info "Installing ${SERVICE_NAME}..."
info "  mc-webui directory: $MCWEBUI_DIR"
info "  mc-webui user: $MCWEBUI_USER"

# Check if updater.py exists
if [ ! -f "$SCRIPT_DIR/updater.py" ]; then
    error "updater.py not found in $SCRIPT_DIR"
fi

# Check if update.sh exists
if [ ! -f "$MCWEBUI_DIR/scripts/update.sh" ]; then
    error "update.sh not found in $MCWEBUI_DIR/scripts/"
fi

# Create service file with correct paths
info "Creating systemd service file..."
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=mc-webui Update Webhook Server
Documentation=https://github.com/MarekWo/mc-webui
After=network.target docker.service

[Service]
Type=simple
User=root
Environment=MCWEBUI_DIR=${MCWEBUI_DIR}
Environment=UPDATER_TOKEN=
ExecStart=/usr/bin/python3 ${SCRIPT_DIR}/updater.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

info "Reloading systemd..."
systemctl daemon-reload

info "Enabling service..."
systemctl enable "$SERVICE_NAME"

info "Starting service..."
systemctl start "$SERVICE_NAME"

# Wait a moment for service to start
sleep 2

# Check if service is running
if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "Service is running!"

    # Test health endpoint
    if command -v curl &> /dev/null; then
        HEALTH=$(curl -s http://127.0.0.1:5050/health 2>/dev/null || echo "")
        if echo "$HEALTH" | grep -q '"status":"ok"'; then
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
echo "The update webhook is now running on port 5050."
echo "You can now use the 'Update' button in mc-webui GUI."
echo ""
echo "Useful commands:"
echo "  systemctl status $SERVICE_NAME   # Check status"
echo "  journalctl -u $SERVICE_NAME -f   # View logs"
echo "  sudo $0 --uninstall              # Uninstall"
