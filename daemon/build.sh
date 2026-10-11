#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIPZ_DIR="$HOME/.clipz"
OUT="$CLIPZ_DIR/clipz-daemon"
FRAMEWORKS="$CLIPZ_DIR/Frameworks"

# llama.cpp runs EmbeddingGemma 2 for semantic search. Pinned to a release that
# includes the gemma-embedding2 architecture (Homebrew's bottle predates it).
LLAMA_TAG="b11552"
LLAMA_ZIP="llama-$LLAMA_TAG-xcframework.zip"
LLAMA_SHA256="ac195b4693da8e250ed778bc66a137912b912c0a6733f9c3e52153d7258172b8"

mkdir -p "$CLIPZ_DIR"

if [[ "$(cat "$FRAMEWORKS/.llama-tag" 2>/dev/null)" != "$LLAMA_TAG" ]]; then
  echo "Fetching llama.cpp $LLAMA_TAG…"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fL --progress-bar -o "$TMP/$LLAMA_ZIP" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/$LLAMA_ZIP"
  echo "$LLAMA_SHA256  $TMP/$LLAMA_ZIP" | shasum -a 256 -c - >/dev/null
  unzip -q "$TMP/$LLAMA_ZIP" -d "$TMP"
  rm -rf "$FRAMEWORKS/llama.framework"
  mkdir -p "$FRAMEWORKS"
  cp -R "$TMP/build-apple/llama.xcframework/macos-arm64_x86_64/llama.framework" "$FRAMEWORKS/"
  echo "$LLAMA_TAG" > "$FRAMEWORKS/.llama-tag"
fi

echo "Compiling clipz-daemon.swift…"
swiftc "$SCRIPT_DIR/clipz-daemon.swift" \
  -framework Foundation \
  -framework AppKit \
  -F "$FRAMEWORKS" \
  -framework llama \
  -Xlinker -rpath -Xlinker "$FRAMEWORKS" \
  -O \
  -o "$OUT"

echo "✓ Binary: $OUT"
