#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
EMBEDDING_MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

log() {
  printf "\n==> %s\n" "$1"
}

warn() {
  printf "\n!! %s\n" "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

ensure_brew() {
  if have brew; then
    return 0
  fi

  log "Installing Homebrew"
  warn "Homebrew is missing, so setup is installing it. Yes, the clipboard app has reached package-manager side quest territory."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  have brew
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Clipz is a macOS thing. Bold of you to try elsewhere, though."
  exit 1
fi

cd "$ROOT_DIR"

log "Checking command line tools"
if ! have swiftc; then
  warn "Swift compiler is missing. Installing Apple's command line tools, because apparently compilers are optional now."
  xcode-select --install || true
  echo "Re-run npm run setup after the Apple installer finishes."
  exit 1
fi

log "Checking Node"
if ! have npm; then
  if ensure_brew; then
    brew install node
  else
    echo "npm is missing and Homebrew is not installed. Install Node.js, then run npm run setup again."
    exit 1
  fi
fi

log "Installing Node dependencies"
npm install

log "Checking Raycast"
if [[ ! -d "/Applications/Raycast.app" ]]; then
  if ensure_brew; then
    brew install --cask raycast
  else
    warn "Raycast is not installed and Homebrew is missing. Install Raycast, then run npm run dev from this repo."
  fi
fi

log "Installing clipboard daemon"
bash "$ROOT_DIR/daemon/install.sh"

log "Checking Ollama"
if ! have ollama; then
  if ensure_brew; then
    brew install ollama
  else
    warn "Ollama is missing and Homebrew is not installed. AI search will wait here patiently, like a feature with standards."
  fi
fi

if have ollama; then
  log "Starting Ollama"
  if have brew; then
    brew services start ollama >/dev/null 2>&1 || true
  fi
  if ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    ollama serve >/tmp/clipz-ollama.log 2>&1 &
  fi

  log "Pulling Ollama model: $MODEL"
  for _ in {1..20}; do
    if curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    ollama pull "$MODEL"
    log "Pulling Ollama embedding model: $EMBEDDING_MODEL"
    ollama pull "$EMBEDDING_MODEL"
  else
    warn "Ollama did not answer at $OLLAMA_URL. Start Ollama and run: ollama pull $MODEL && ollama pull $EMBEDDING_MODEL"
  fi
fi

log "Building Raycast extension"
npm run build

cat <<EOF

Clipz setup is done.

Next:
  npm run dev

Raycast will load the extension from this folder. macOS may ask for Accessibility,
Automation, or Full Disk Access permissions for the daemon. Naturally.

Database:
  iCloud Drive when available:
    ~/Library/Mobile Documents/com~apple~CloudDocs/Clipz/history.db
  Local fallback:
    ~/.clipz/history.db
EOF
