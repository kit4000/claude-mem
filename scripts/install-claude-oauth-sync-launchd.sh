#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="${CLAUDE_MEM_OAUTH_SYNC_LABEL:-com.claude-mem.oauth-sync}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
INTERVAL="${CLAUDE_MEM_OAUTH_SYNC_INTERVAL:-300}"
TARGET="${CLAUDE_MEM_HOST_CREDENTIALS_FILE:-$REPO_ROOT/.docker-claude-code-credentials.json}"
MIRROR="${CLAUDE_MEM_MIRROR_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
LOG_DIR="${CLAUDE_MEM_OAUTH_SYNC_LOG_DIR:-$HOME/.claude-mem/logs}"
SCRIPT="$REPO_ROOT/scripts/sync-claude-oauth-credentials.mjs"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: launchd OAuth sync is only supported on macOS." >&2
  exit 1
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "ERROR: node was not found. Set NODE_BIN=/absolute/path/to/node." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: sync script not found: $SCRIPT" >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR" "$HOME/.claude"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

echo "[oauth-sync] running one foreground sync..."
"$NODE_BIN" "$SCRIPT" --target "$TARGET" --mirror "$MIRROR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$SCRIPT")</string>
    <string>--target</string>
    <string>$(xml_escape "$TARGET")</string>
    <string>--mirror</string>
    <string>$(xml_escape "$MIRROR")</string>
    <string>--notify-on-stale</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_ROOT")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$(xml_escape "$INTERVAL")</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/oauth-sync.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/oauth-sync.err.log")</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "[oauth-sync] installed launch agent: $PLIST"
echo "[oauth-sync] target: $TARGET"
echo "[oauth-sync] mirror: $MIRROR"
echo "[oauth-sync] interval: ${INTERVAL}s"
