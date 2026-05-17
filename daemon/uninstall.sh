#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.clipz.daemon.plist"

launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo "✓ Clipz daemon uninstalled"
echo "  (Database preserved in iCloud Drive if enabled, otherwise ~/.clipz/history.db)"
