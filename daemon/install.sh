#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIPZ_DIR="$HOME/.clipz"
BINARY="$CLIPZ_DIR/clipz-daemon"
MODEL_DIR="$CLIPZ_DIR/models"
MODEL_FILE="$MODEL_DIR/embeddinggemma-2-Q8_0.gguf"
# EmbeddingGemma 2 (text, Q8_0) from ggml-org, pinned to a revision so the checksum holds.
MODEL_URL="https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf"
MODEL_SHA256="2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135"
PLIST_PATH="$HOME/Library/LaunchAgents/com.clipz.daemon.plist"
NODE_BIN="$(which node 2>/dev/null || echo "")"

# ── 1. Build daemon binary ────────────────────────────────────────────────────
bash "$SCRIPT_DIR/build.sh"

# ── 2. Download the embedding model for semantic search ──────────────────────
mkdir -p "$MODEL_DIR"
if ! echo "$MODEL_SHA256  $MODEL_FILE" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "Downloading EmbeddingGemma 2 (~300 MB)…"
  curl -fL --progress-bar -C - -o "$MODEL_FILE.part" "$MODEL_URL"
  echo "$MODEL_SHA256  $MODEL_FILE.part" | shasum -a 256 -c - >/dev/null
  mv "$MODEL_FILE.part" "$MODEL_FILE"
fi

# ── 3. Write LaunchAgent plist ────────────────────────────────────────────────
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

# ── 4. Load / reload ──────────────────────────────────────────────────────────
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"

echo ""
echo "✓ Clipz daemon installed and running"
echo ""
echo "  Binary  : $BINARY"
echo "  Database: iCloud Drive when available, otherwise $CLIPZ_DIR/history.db"
echo "  Model   : $MODEL_FILE"
echo "  Logs    : $CLIPZ_DIR/daemon.log"
echo ""
echo "Next steps:"
echo "  1. Run the full setup if you have not already:  bash scripts/setup.sh"
echo "  2. Load the Raycast extension:  npm run dev"
