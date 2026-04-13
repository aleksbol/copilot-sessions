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
devtunnel create copilot-sessions
devtunnel port create copilot-sessions -p 3847

# Start hosting (run alongside the server)
devtunnel host copilot-sessions
```

The tunnel URL is stable — bookmark it on your phone.

## Authentication (Required)

The server uses Microsoft Entra ID (Azure AD) to authenticate users. Only a single specified user is allowed access.

### 1. Register an Azure AD App

1. Go to [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Name: `Copilot Sessions` (or anything you like)
4. Supported account types: **Single tenant** (or multi-tenant if using across personal/work)
5. Redirect URI: **Web** → `http://localhost:3847/auth/callback`
   - For devtunnel access, also add your tunnel URL: `https://<tunnel-id>.devtunnels.ms/auth/callback`
6. Click **Register**
7. Copy the **Application (client) ID** and **Directory (tenant) ID**

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
AUTH_TENANT_ID=your-tenant-id
AUTH_CLIENT_ID=your-client-id
AUTH_ALLOWED_USER=you@example.com
```

The server will refuse to start if any of these are missing.

### 3. Multiple Tenants

If you use this from both a personal and work Microsoft tenant, register an app in each tenant and switch the `.env` values as needed (or use a multi-tenant app registration).

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
