#!/bin/bash
#
# mc-webui update script
# Updates the application from Git and rebuilds Docker containers
#
# Usage:
#   ./scripts/update.sh          # Run from mc-webui directory
#   mcupdate                     # If alias is configured (see README)
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored status messages
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Determine mc-webui directory
if [ -f "docker-compose.yml" ] && [ -d "app" ]; then
    MCWEBUI_DIR="$(pwd)"
elif [ -n "$MCWEBUI_DIR" ] && [ -d "$MCWEBUI_DIR" ]; then
    cd "$MCWEBUI_DIR"
elif [ -d "$HOME/mc-webui" ]; then
    MCWEBUI_DIR="$HOME/mc-webui"
    cd "$MCWEBUI_DIR"
else
    error "Cannot find mc-webui directory. Run from mc-webui folder or set MCWEBUI_DIR environment variable."
fi

info "Updating mc-webui in: $MCWEBUI_DIR"
echo ""

# Step 1: Git pull
info "Pulling latest changes from Git..."
# Force HTTP/1.1 for the pull. GitHub's HTTP/2 edge rejects the anonymous
# git-upload-pack POST sent by older git/libcurl (e.g. Debian bookworm's
# git 2.39 + libcurl 7.88) with a 401, which git reports as a credential
# prompt - "Username for 'https://github.com'" - even on this public repo.
# GIT_TERMINAL_PROMPT=0 turns any auth failure into an error instead of
# leaving the script waiting on stdin forever.
if GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 pull; then
    success "Git pull completed"
else
    error "Git pull failed"
fi
echo ""

# Step 2: Freeze version
info "Freezing version..."
if python3 -m app.version freeze; then
    success "Version frozen"
else
    warn "Version freeze failed (non-critical, continuing...)"
fi
echo ""

# Step 3: Rebuild and restart containers
info "Rebuilding and restarting Docker containers..."
if docker compose up -d --build; then
    success "Containers rebuilt and started"
else
    error "Docker compose failed"
fi
echo ""

# Step 4: Show status
info "Container status:"
docker compose ps
echo ""

# Step 5: Show version
if command -v curl &> /dev/null; then
    sleep 2  # Wait for container to start
    VERSION=$(curl -s http://localhost:5000/api/version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$VERSION" ]; then
        success "mc-webui updated to version: $VERSION"
    else
        warn "Could not fetch version (container may still be starting)"
    fi
fi

echo ""
echo -e "${GREEN}Update complete!${NC}"
