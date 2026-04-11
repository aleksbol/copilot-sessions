# Copilot Sessions

Access GitHub Copilot CLI sessions from any device via a mobile-friendly web interface.

## How It Works

```
Phone/Browser ←→ DevTunnel ←→ Bridge Server ←→ Copilot SDK ←→ Copilot CLI
```

The bridge server uses the [Copilot SDK](https://github.com/github/copilot-sdk) to drive the real Copilot CLI agent — same model, same tools, same capabilities. No tool reimplementation needed.

## Prerequisites

- **Node.js** 18+ 
- **Copilot CLI** installed and authenticated: `npm install -g @github/copilot`
- **Copilot subscription** (Free, Pro, Business, or Enterprise)
- **DevTunnel** (optional, for phone access): `winget install Microsoft.devtunnel`

## Quick Start

```bash
# Install dependencies
npm install

# Start the bridge server
npm run dev

# Open http://localhost:3847 in your browser
```

## Remote Access (Phone)

```bash
# Create a persistent tunnel (one-time)
devtunnel create copilot-sessions --allow-anonymous
devtunnel port create copilot-sessions -p 3847

# Start hosting (run alongside the server)
devtunnel host copilot-sessions
```

The tunnel URL is stable — bookmark it on your phone.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3847` | Server port |
| `COPILOT_MODEL` | `claude-sonnet-4-5` | Default LLM model |
| `COPILOT_CWD` | current directory | Default working directory |
| `COPILOT_SESSIONS_DIR` | `~/.copilot-sessions` | Session storage path |

## Architecture

- **`src/server.ts`** — Express + WebSocket bridge server, connects to Copilot SDK
- **`src/store.ts`** — File-based session persistence (JSONL message logs)
- **`src/types.ts`** — Shared TypeScript types for the WebSocket protocol
- **`public/`** — Mobile-first web frontend (vanilla JS, no build step)
