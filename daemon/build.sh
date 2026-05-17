#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$HOME/.clipz/clipz-daemon"

mkdir -p "$HOME/.clipz"

echo "Compiling clipz-daemon.swift…"
swiftc "$SCRIPT_DIR/clipz-daemon.swift" \
  -framework Foundation \
  -framework AppKit \
  -O \
  -o "$OUT"

echo "✓ Binary: $OUT"
