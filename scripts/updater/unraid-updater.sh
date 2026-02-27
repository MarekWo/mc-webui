#!/bin/bash
set -euo pipefail

# ============================================================
# mc-webui Unraid updater
#
# Purpose:
#   Keep a local mc-webui checkout up-to-date and (re)deploy the
#   Docker Compose stack in a predictable, automation-friendly way.
#
# High-level flow:
#   1) Fetch updates from origin (all branches)
#   2) Select target branch (sticky behavior)
#   3) Pull latest changes (fast-forward only)
#   4) Freeze version on the host BEFORE building images
#   5) If needed (changes/force/branch switch): rebuild + restart
#   6) Optionally wait for healthcheck
#   7) Verify the *actual* running version from inside the container
#
# Key design points:
#   - "Sticky branch": if you switch to dev once, it stays dev until you
#     explicitly switch back to main (via TARGET_BRANCH=main).
#   - "Cache safety": after switching branches, we force a clean rebuild of
#     mc-webui to avoid stale build cache producing an image from the previous branch.
#   - "Ground truth": we confirm the running VERSION_STRING from inside the container
#     (UI/browser can mislead; git on host can mislead if build cache lies).
#
# Environment variables:
#   TARGET_BRANCH=main|dev
#       Optional. If set, repo is switched to that branch before update.
#       If empty: keep current branch (sticky).
#
#   BRANCH_STRATEGY=reset|ff-only
#       reset:   hard-reset local branch to origin/<branch> (discard local edits)
#       ff-only: do not reset; only allow fast-forward pulls
#
#   CLEAN_UNTRACKED=0|1
#       Only used with BRANCH_STRATEGY=reset.
#       1 = git clean -fd (removes untracked files/dirs) -> destructive.
#
#   FORCE_REBUILD=0|1
#       1 = redeploy even if no git changes
#
#   DOCKER_TIMEOUT=600
#       Timeout (seconds) for compose commands. 0 disables timeout wrapper.
#
#   WAIT_HEALTH_SECONDS=60
#       Wait up to N seconds for mc-webui health=healthy. 0 disables waiting.
# ============================================================

APPDIR="/mnt/user/appdata/mc-webui"
LOG="$APPDIR/updater.log"
LOCK="/tmp/mc-webui-updater.lock"

FORCE_REBUILD="${FORCE_REBUILD:-0}"
DOCKER_TIMEOUT="${DOCKER_TIMEOUT:-600}"
WAIT_HEALTH_SECONDS="${WAIT_HEALTH_SECONDS:-60}"

TARGET_BRANCH="${TARGET_BRANCH:-}"
BRANCH_STRATEGY="${BRANCH_STRATEGY:-reset}"
CLEAN_UNTRACKED="${CLEAN_UNTRACKED:-0}"

# If stdout is a TTY, also print logs to console.
IS_TTY=0; [[ -t 1 ]] && IS_TTY=1
timestamp() { date '+%F %T'; }

log() {
  local msg="$1"
  if [[ "$IS_TTY" == "1" ]]; then
    echo "$msg" | tee -a "$LOG"
  else
    echo "$msg" >>"$LOG"
  fi
}

# ------------------------------------------------------------
# Help / usage
# ------------------------------------------------------------
print_help() {
  cat <<'EOF'
mc-webui Unraid updater

Usage:
  unraid-updater.sh [--help|-h]

This script is controlled primarily via environment variables.

Examples:
  # Update on current (sticky) branch
  /mnt/user/appdata/mc-webui/scripts/unraid-updater.sh

  # Switch to dev (sticky) and redeploy
  TARGET_BRANCH=dev /mnt/user/appdata/mc-webui/scripts/unraid-updater.sh

  # Switch back to main (sticky) and force redeploy
  TARGET_BRANCH=main FORCE_REBUILD=1 /mnt/user/appdata/mc-webui/scripts/unraid-updater.sh

Environment variables:
  TARGET_BRANCH=main|dev
      Optional. If set, repo is switched to that branch before update.
      If empty: keep current branch (sticky behavior).

  BRANCH_STRATEGY=reset|ff-only
      reset:   hard-reset local branch to origin/<branch> (discard local edits)
      ff-only: do not reset; only allow fast-forward pulls

  CLEAN_UNTRACKED=0|1
      Only used with BRANCH_STRATEGY=reset.
      1 = git clean -fd (removes untracked files/dirs) -> destructive.

  FORCE_REBUILD=0|1
      1 = redeploy even if no git changes

  DOCKER_TIMEOUT=600
      Timeout (seconds) for compose commands. 0 disables timeout wrapper.

  WAIT_HEALTH_SECONDS=60
      Wait up to N seconds for mc-webui health=healthy. 0 disables waiting.

Exit codes:
  0  Success (or skipped because another run is in progress)
  1  Hard failure (git/compose errors, invalid configuration, etc.)
EOF
}

# Show help early (before lock/log noise)
case "${1:-}" in
  -h|--help|help)
    print_help
    exit 0
    ;;
esac

# Run a command, optionally wrapped with timeout, and stream output into the log.
run_cmd() {
  local prefix="$1"; shift
  if [[ "$DOCKER_TIMEOUT" != "0" ]] && command -v timeout >/dev/null 2>&1; then
    timeout "$DOCKER_TIMEOUT" "$@" 2>&1 | while IFS= read -r line; do log "[$prefix] $line"; done
  else
    "$@" 2>&1 | while IFS= read -r line; do log "[$prefix] $line"; done
  fi
}

log "=================================================="
log "[INFO] $(timestamp) mc-webui update start"
log "[INFO] APPDIR=$APPDIR"
log "[INFO] FORCE_REBUILD=$FORCE_REBUILD"
log "[INFO] DOCKER_TIMEOUT=$DOCKER_TIMEOUT"
log "[INFO] WAIT_HEALTH_SECONDS=$WAIT_HEALTH_SECONDS"
log "[INFO] TARGET_BRANCH=${TARGET_BRANCH:-<keep-current>}"
log "[INFO] BRANCH_STRATEGY=$BRANCH_STRATEGY"
log "[INFO] CLEAN_UNTRACKED=$CLEAN_UNTRACKED"

# Prevent concurrent runs (cron/manual overlap). Lock is released on exit via trap.
if ! ( set -o noclobber; echo "$$" > "$LOCK" ) 2>/dev/null; then
  log "[WARN] Lock exists ($LOCK). Another run in progress. Exiting."
  exit 0
fi
trap 'rm -f "$LOCK"' EXIT

cd "$APPDIR"

# Running git as root on Unraid + appdata path may trigger "dubious ownership".
git config --global --add safe.directory "$APPDIR" >/dev/null 2>&1 || true

# Detect Compose CLI (v2 preferred, legacy fallback).
COMPOSE=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  log "[ERROR] docker compose not found."
  exit 1
fi
log "[INFO] Using compose command: ${COMPOSE[*]}"

# Basic sanity check: ensure there is a compose file.
if [[ ! -f "$APPDIR/docker-compose.yml" && ! -f "$APPDIR/compose.yml" ]]; then
  log "[ERROR] No docker-compose.yml or compose.yml found in $APPDIR"
  exit 1
fi

OLD="$(git rev-parse HEAD 2>/dev/null || true)"
log "[INFO] Current commit: ${OLD:-<none>}"

# Ensure origin fetches all branches (important if the clone was created as single-branch).
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1 || true

log "[INFO] git fetch..."
git fetch --all --prune 2>&1 | while IFS= read -r line; do log "[GIT] $line"; done

# ------------------------------------------------------------
# Branch selection (sticky behavior)
# ------------------------------------------------------------
BRANCH_SWITCHED=0
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
log "[INFO] Current branch: $CURRENT_BRANCH"

# If TARGET_BRANCH is not provided:
#   - keep current branch (sticky)
#   - if in detached HEAD (rare), default to main
if [[ -z "$TARGET_BRANCH" ]]; then
  if [[ "$CURRENT_BRANCH" == "HEAD" || "$CURRENT_BRANCH" == "unknown" ]]; then
    TARGET_BRANCH="main"
    log "[INFO] No TARGET_BRANCH set and repo is detached → defaulting to main"
  else
    TARGET_BRANCH="$CURRENT_BRANCH"
    log "[INFO] No TARGET_BRANCH set → keeping current branch: $TARGET_BRANCH"
  fi
else
  log "[INFO] TARGET_BRANCH explicitly set by user: $TARGET_BRANCH"
fi

# Restrict to known branches (adjust if you add more later).
if [[ "$TARGET_BRANCH" != "main" && "$TARGET_BRANCH" != "dev" ]]; then
  log "[ERROR] TARGET_BRANCH must be 'main' or 'dev' (got: $TARGET_BRANCH)"
  exit 1
fi

# Switch if required.
if [[ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]]; then
  BRANCH_SWITCHED=1
  log "[INFO] Switching branch → $TARGET_BRANCH"

  # Ensure remote branch exists.
  if ! git show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
    log "[ERROR] Remote branch origin/$TARGET_BRANCH not found."
    exit 1
  fi

  # Checkout existing local branch or create a tracking branch from origin.
  if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    git checkout "$TARGET_BRANCH" 2>&1 | while IFS= read -r line; do log "[GIT] $line"; done
  else
    git checkout -b "$TARGET_BRANCH" "origin/$TARGET_BRANCH" 2>&1 | while IFS= read -r line; do log "[GIT] $line"; done
  fi

  # Align local state with origin (optional but recommended for unattended servers).
  if [[ "$BRANCH_STRATEGY" == "reset" ]]; then
    log "[INFO] Resetting branch to origin/$TARGET_BRANCH"
    git reset --hard "origin/$TARGET_BRANCH" 2>&1 | while IFS= read -r line; do log "[GIT] $line"; done

    # Optional cleanup of untracked files. Destructive — enable only if you want a pristine tree.
    if [[ "$CLEAN_UNTRACKED" == "1" ]]; then
      log "[INFO] Cleaning untracked files (CLEAN_UNTRACKED=1)"
      git clean -fd 2>&1 | while IFS= read -r line; do log "[GIT] $line"; done
    else
      log "[INFO] Skipping git clean (CLEAN_UNTRACKED=0) — local files preserved"
    fi
  elif [[ "$BRANCH_STRATEGY" == "ff-only" ]]; then
    log "[INFO] Using ff-only strategy (no reset)"
  else
    log "[ERROR] BRANCH_STRATEGY must be 'reset' or 'ff-only' (got: $BRANCH_STRATEGY)"
    exit 1
  fi
fi

# Pull latest changes (no merges).
log "[INFO] git pull..."
PULL_OUTPUT="$(git pull --ff-only 2>&1 || true)"
while IFS= read -r line; do log "[GIT] $line"; done <<< "$PULL_OUTPUT"
if echo "$PULL_OUTPUT" | grep -qiE '^(fatal:|error:)' ; then
  log "[ERROR] git pull failed. Aborting."
  exit 1
fi

NEW="$(git rev-parse HEAD 2>/dev/null || true)"
log "[INFO] New commit: ${NEW:-<none>}"

# Detect whether the checked-out commit changed.
CHANGED=0
if [[ -n "${NEW:-}" && ( -z "${OLD:-}" || "${OLD:-}" != "${NEW:-}" ) ]]; then
  CHANGED=1
fi

# Decide whether to redeploy.
NEED_DEPLOY=0
if [[ "$FORCE_REBUILD" == "1" || "$CHANGED" == "1" || "$BRANCH_SWITCHED" == "1" ]]; then
  NEED_DEPLOY=1
fi

# Freeze version on host BEFORE building images.
# This is informational and also writes RUNNING_VERSION.txt for quick lookup.
log "[INFO] Version freeze (host, before build):"
FREEZE_OUT="$(python3 -m app.version freeze 2>&1 || true)"
while IFS= read -r line; do log "[FREEZE] $line"; done <<< "$FREEZE_OUT"
echo "$FREEZE_OUT" > "$APPDIR/RUNNING_VERSION.txt" 2>/dev/null || true

if [[ "$NEED_DEPLOY" == "0" ]]; then
  log "[INFO] No changes, no branch switch, FORCE_REBUILD!=1 → skipping deploy."
else
  if [[ "$BRANCH_SWITCHED" == "1" ]]; then
    log "[INFO] Branch switched → redeploying stack."
  elif [[ "$CHANGED" == "1" ]]; then
    log "[INFO] Repository changes detected → redeploying stack."
  else
    log "[INFO] FORCE_REBUILD=1 → forcing redeploy."
  fi

  # Critical cache-safety rule:
  # Switching branches can leave Docker build cache in a state that produces an image
  # inconsistent with the current working tree. To prevent this, force a clean rebuild
  # of mc-webui when the branch changes.
  if [[ "$BRANCH_SWITCHED" == "1" ]]; then
    log "[INFO] Branch switched → docker compose build --no-cache mc-webui"
    run_cmd "BUILD" "${COMPOSE[@]}" build --no-cache mc-webui
  fi

  # Bring the stack up, building images if needed.
  log "[INFO] Running docker compose up -d --build..."
  run_cmd "UP" "${COMPOSE[@]}" up -d --build --remove-orphans

  # Optional health wait.
  if [[ "$WAIT_HEALTH_SECONDS" != "0" ]]; then
    log "[INFO] Waiting up to ${WAIT_HEALTH_SECONDS}s for mc-webui health=healthy..."
    end=$((SECONDS + WAIT_HEALTH_SECONDS))
    while (( SECONDS < end )); do
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' mc-webui 2>/dev/null || echo "not-found")"
      status="$(docker inspect -f '{{.State.Status}}' mc-webui 2>/dev/null || echo "not-found")"
      log "[INFO] mc-webui status=$status health=$health"
      [[ "$health" == "healthy" || "$health" == "no-healthcheck" ]] && break
      [[ "$status" != "running" ]] && break
      sleep 2
    done
  fi

  log "[INFO] Container status:"
  "${COMPOSE[@]}" ps 2>&1 | while IFS= read -r line; do log "[PS] $line"; done || true
fi

# Verify the actual running version from inside the container (ground truth).
log "[INFO] Verifying version inside container:"
CONTAINER_VER="$(docker compose exec -T mc-webui python3 -c 'from app import version; print(version.VERSION_STRING)' 2>/dev/null || true)"
log "[INFO] mc-webui VERSION_STRING (container): ${CONTAINER_VER:-<failed>}"

log "[INFO] $(timestamp) mc-webui update finished successfully"
HOST_VER="$(python3 -c 'from app import version; print(version.VERSION_STRING)' 2>/dev/null || echo '<host-unknown>')"
log "[INFO] Host VERSION_STRING: $HOST_VER"
if [[ -n "${CONTAINER_VER:-}" && "$HOST_VER" != "<host-unknown>" && "$CONTAINER_VER" != "$HOST_VER" ]]; then
  log "[WARN] Host version != container version. Consider forcing rebuild (FORCE_REBUILD=1) or switching branch explicitly."
fi
