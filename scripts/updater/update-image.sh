#!/bin/bash
#
# mc-webui update script - Docker Hub / GHCR image installations
#
# Counterpart to scripts/update.sh: that one rebuilds a git checkout, this one
# pulls the published image and recreates the container. Used by installations
# that never cloned the repository (README "Option A: Docker Hub"), where there
# is nothing to git pull and nothing to build.
#
# Usage:
#   ./update-image.sh            # run from the mc-webui directory
#   MCWEBUI_DIR=~/mc-webui ./update-image.sh
#
# Prints MC_UPDATE_RESULT=updated|no_change on the last line so the updater
# webhook can tell "container recreated" from "the registry had nothing new".
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Determine mc-webui directory - the one holding docker-compose.yml
find_compose_dir() {
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

MCWEBUI_DIR="$(find_compose_dir "$MCWEBUI_DIR" "$(pwd)" "$HOME/mc-webui")" \
    || error "Cannot find docker-compose.yml. Run from the mc-webui folder or set MCWEBUI_DIR."
cd "$MCWEBUI_DIR"

# Compose v2 (docker compose) with a fallback to the standalone v1 binary
if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
else
    error "Neither 'docker compose' nor 'docker-compose' is available"
fi

info "Updating mc-webui in: $MCWEBUI_DIR"
echo ""

# Step 1: Remember which images we are running right now.
# Image IDs, not tags - the tag stays 'latest' across every update, so the ID
# is the only thing that tells us whether the pull actually brought anything.
images_fingerprint() {
    local ref
    for ref in $("${COMPOSE[@]}" config --images 2>/dev/null); do
        echo "$ref=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || echo missing)"
    done
}

BEFORE="$(images_fingerprint)"

# Step 2: Pull the published image
info "Pulling the latest image..."
if "${COMPOSE[@]}" pull; then
    success "Pull completed"
else
    error "Image pull failed"
fi
echo ""

AFTER="$(images_fingerprint)"

if [ "$BEFORE" == "$AFTER" ]; then
    CHANGED=false
    warn "The registry has no newer image than the one already running."
    warn "A commit can be on GitHub for a while before its image finishes building."
else
    CHANGED=true
    success "A newer image was downloaded"
fi
echo ""

# Step 3: Recreate the container.
# Run this even when nothing was pulled: it is also what brings a stopped or
# crash-looping container back up, which is half the reason people press Update.
info "Recreating containers..."
if "${COMPOSE[@]}" up -d; then
    success "Containers started"
else
    error "Docker compose failed"
fi
echo ""

# Step 4: Show status
info "Container status:"
"${COMPOSE[@]}" ps
echo ""

# Step 5: Show version
if command -v curl &> /dev/null; then
    sleep 2  # Wait for container to start
    PORT="${FLASK_PORT:-5000}"
    VERSION=$(curl -s "http://localhost:${PORT}/api/version" 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$VERSION" ]; then
        success "mc-webui is running version: $VERSION"
    else
        warn "Could not fetch version (container may still be starting)"
    fi
fi

echo ""
if [ "$CHANGED" == "true" ]; then
    echo -e "${GREEN}Update complete!${NC}"
else
    echo -e "${YELLOW}Nothing to update - already on the newest published image.${NC}"
fi

# Machine-readable result for the updater webhook - keep this the last line.
# Only when stdout is not a terminal: the webhook captures output through a
# pipe, while a human running this by hand has already read the same thing in
# plain words just above and does not need the marker in their terminal.
if [ ! -t 1 ]; then
    if [ "$CHANGED" == "true" ]; then
        echo "MC_UPDATE_RESULT=updated"
    else
        echo "MC_UPDATE_RESULT=no_change"
    fi
fi
