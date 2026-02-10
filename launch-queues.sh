#!/usr/bin/env bash
set -euo pipefail

# ── Configuration (overridable via environment variables) ────────────
BROWSER_COUNT="${BROWSER_COUNT:-5}"
TARGET_URL="${TARGET_URL:-https://queue.rundisney.com/?c=rundisney&e=EVENT_ID&t=https%3A%2F%2Fwww.rundisney.com%2F}"
# ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# Ensure Chromium binaries are available (no-op if already installed)
log "Checking Chromium browser binaries..."
npx --prefix "$SCRIPT_DIR" playwright install chromium
log "Chromium ready."

log "Launching $BROWSER_COUNT browser sessions targeting:"
log "  $TARGET_URL"

exec node "$SCRIPT_DIR/server.js"
