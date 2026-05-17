#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIPZ_DIR="$HOME/.clipz"
BINARY="$CLIPZ_DIR/clipz-daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/com.clipz.daemon.plist"
NODE_BIN="$(which node 2>/dev/null || echo "")"

# ── 1. Build daemon binary ────────────────────────────────────────────────────
bash "$SCRIPT_DIR/build.sh"

# ── 2. Write LaunchAgent plist ────────────────────────────────────────────────
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.clipz.daemon</string>

  <key>ProgramArguments</key>
  <array>
    <string>$BINARY</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$CLIPZ_DIR/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>$CLIPZ_DIR/daemon.err.log</string>
</dict>
</plist>
PLIST

# ── 3. Load / reload ──────────────────────────────────────────────────────────
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"

echo ""
echo "✓ Clipz daemon installed and running"
echo ""
echo "  Binary  : $BINARY"
echo "  Database: iCloud Drive when available, otherwise $CLIPZ_DIR/history.db"
echo "  Logs    : $CLIPZ_DIR/daemon.log"
echo ""
echo "Next steps:"
echo "  1. Run the full setup if you have not already:  bash scripts/setup.sh"
echo "  2. Load the Raycast extension:  npm run dev"
