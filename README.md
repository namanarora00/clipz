# Clipz

I made a clipboard manager because apparently that was still a problem

Clipz is a Raycast extension with a tiny macOS daemon that remembers what you copied, where it came from, and how to get back there. Groundbreaking, I know. It also lets you interrogate your clipboard with local Ollama, because apparently even paste history needs AI now.

No hosted API. No mystery clipboard cloud. Search runs locally. AI defaults to `http://localhost:11434`. iCloud sync is optional from Raycast; otherwise the database stays in `~/.clipz`, where your shame belongs.

## Features

- Search clipboard history without pretending one clipboard slot is a personality
- Track source apps, browser URLs, and editor files when possible
- Semantic search with local Ollama embeddings, because exact keyword matching was getting smug
- Jump back to copied web text instead of opening a page and saying "good luck"
- Ask Ollama questions about your clipboard history, because scrolling is manual labor
- Auto-hide obvious secrets like API keys, tokens, private keys, JWTs, and env vars before you demo your screen like a genius
- Optional iCloud Drive sync, with local fallback if Apple ID stuff is being Apple ID stuff

## Privacy

Your clipboard history stays on your machine unless you turn on iCloud sync. There are no Clipz servers. I cannot leak your data to my backend because, tragically, I did not build one.

Secret detection is best-effort: a seatbelt, not a vault. Search through your API keys all you want. A terrible idea, but at least it is your terrible idea.

## Storage

- Local: `~/.clipz/history.db`
- iCloud sync: `~/Library/Mobile Documents/com~apple~CloudDocs/Clipz/history.db`
- Config: `~/.clipz/config.json`

No artificial item limit. Your real limits are disk space, iCloud storage if enabled, SQLite, and your tolerance for preserving every weird thing you copied at 2 AM for "later."

## Setup

```bash
bash scripts/setup.sh
```

That installs Homebrew when needed, Node deps, Raycast, the daemon, Ollama, the default chat model, the embedding model, and builds the extension. Ridiculous amount of ceremony for remembering text, but here we are. Then run:

```bash
npm run dev
```

Manual mode, if suffering builds character:

```bash
npm install
npm run build
npm run lint
./daemon/install.sh
```
