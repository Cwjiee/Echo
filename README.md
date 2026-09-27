# Echo

> AI-powered Developer Experience (DevEx) tool that automates codebase updates via GitHub webhooks, AI summaries, Discord/Slack notifications, and local Mac execution.

## Architecture

```
GitHub Webhook → Backend API (FastAPI + Socket.IO) → Discord Bot → Developer approves
                                    ↓
                          Mac Agent (Electron tray)
                                    ↓
                       local-executor (MCP agent: git, npm)
```

## Monorepo Structure

```
echo/
├── apps/
│   ├── backend/          # FastAPI + Socket.IO WebSocket bridge (Python)
│   ├── bot/              # Discord bot with interactive buttons (TypeScript)
│   └── mac-agent/        # Electron menu bar tray app (TypeScript)
├── packages/
│   ├── local-executor/   # MCP agent: git/npm execution engine (TypeScript)
│   └── config/           # Shared ESLint + TSConfig
├── turbo.json
└── package.json
```

## Prerequisites

- Node.js >= 20
- Python >= 3.12
- Docker & Docker Compose
- npm >= 10

## Quick Start

### 1. Install dependencies

```bash
npm install
pip install -r apps/backend/requirements.txt
```

### 2. Start infrastructure (Postgres + Redis)

```bash
npm run docker:up
```

### 3. Start all services in development mode

```bash
npm run dev
```

Or individually:

```bash
npm run dev:backend   # FastAPI on :8000
npm run dev:bot       # Discord bot
npm run dev:mac-agent # Electron tray app
```

## Apps

### `apps/backend` — FastAPI + Socket.IO

| Endpoint | Description |
|---|---|
| `GET /api/health` | Health check |
| `POST /api/webhooks/github` | GitHub webhook ingestion |
| `ws://` | Socket.IO server for Mac agent connections |

**Environment variables:**
```
DATABASE_URL=postgresql+asyncpg://echo:echo@localhost:5432/echo
REDIS_URL=redis://localhost:6379/0
GITHUB_WEBHOOK_SECRET=changeme
```

### `apps/bot` — Discord Bot

- Listens to backend WebSocket for `github_event` payloads
- Posts embeds with **Sync Local Env** / **Dismiss** buttons
- `/sync` slash command for manual triggers
- Relays approvals back to backend

**Environment variables:** See `apps/bot/.env.example`

### `apps/mac-agent` — Electron Menu Bar App

- Lives in the macOS menu bar (no Dock icon)
- Settings window: Backend URL + Auth Token + Workspace
- Connects to backend via authenticated Socket.IO
- Delegates `approved_resolution` payloads to `@echo/local-executor`

### `packages/local-executor` — MCP Execution Engine

Exposes as both an importable library and a standalone MCP server:

| Tool | Description |
|---|---|
| `git_status` | `git status --porcelain` |
| `git_fetch` | `git fetch <remote>` |
| `git_pull` | `git pull <remote> <branch>` |
| `npm_install` | `npm install` |
| `run_tests` | `npm test` |

## Cloud Deployment

### Docker (local)
```bash
docker-compose -f apps/backend/docker-compose.yml up
```

### AWS (Terraform)
```bash
cd apps/backend/infra/terraform
terraform init
terraform apply -var="db_password=yourpassword"
```

### AWS SAM (serverless)
```bash
cd apps/backend/infra/sam
sam build && sam deploy --guided
```

## Communication Flow

```
1. GitHub pushes webhook → POST /api/webhooks/github
2. Backend validates HMAC signature
3. Background task: AI Analyzer generates summary + resolution actions
4. Backend broadcasts 'github_event' over Socket.IO
5. Bot receives event → posts Discord embed with buttons
6. Developer clicks "Sync Local Env" button
7. Bot emits 'approval_response' → Backend receives
8. Backend emits 'approved_resolution' → Mac Agent receives
9. Mac Agent → local-executor runs: git fetch, git pull, npm install
10. Results reported back to backend → Bot updates Discord message
```
