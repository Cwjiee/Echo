You are an expert Full-Stack Engineer and DevOps Architect. Your task is to scaffold a monorepo for a new AI-powered Developer Experience (DevEx) tool. 

This tool automates codebase updates by analyzing GitHub webhooks, generating AI summaries, pushing interactive notifications to Discord/Slack, and executing approved changes locally on a developer's machine via a Mac menu bar app.

Please initialize a new project monorepo using Turborepo (or your recommended monorepo manager) and scaffold the following directory structure and base boilerplates:

### 1. /apps/backend (Core API & Cloud AI Agent)
- Scaffold a python FastApi server.
- Add a basic webhook ingestion route (`POST /api/webhooks/github`) to receive GitHub events.
- Add a WebSocket server (using Socket.io) to manage active connections with local Mac apps.
- Create a placeholder service for the Cloud AI Agent (e.g., `services/ai-analyzer.ts`) to process diffs.
- Include a `Dockerfile` and a `docker-compose.yml` to easily spin up the backend and a local Redis/Postgres instance for state management.
- Provide a basic AWS SAM or Terraform template in an `/infra` folder for cloud deployment.

### 2. /apps/bot (ChatOps)
- Scaffold a basic Discord bot using `discord.js`.
- Set up the connection logic to listen to the Backend API for formatted release notes.
- Include placeholder logic for interactive message components (e.g., a "Sync Local Env" button or `/sync` command) that pushes approvals back to the backend.

### 3. /apps/mac-agent (Local Dev Agent)
- Scaffold a lightweight Mac desktop application using swift or Electron.
- The UI should be a simple Menu Bar tray application with a toggle to "Connect to Server" and an input for an auth token.
- Include the client-side WebSocket logic to connect to the backend and listen for the "approved_resolution" payload.

### 4. /packages/local-executor (Execution Engine)
- Scaffold a local mcp agent.
- Create placeholder functions for Git operations (`git status`, `git fetch`, `git pull`).
- Create placeholder functions for package management (`npm install`) and tests.
- Export these functions so they can be securely imported and triggered by the `mac-agent` when an approval payload is received.

### Requirements:
- Use TypeScript strictly across all workspaces.
- Set up a shared ESLint and Prettier configuration in a `/packages/config` directory.
- Initialize `package.json` scripts at the root to easily run the backend, bot, and desktop app concurrently in development mode.
- Do not implement the full business logic; focus on the architectural wiring, directories, Docker configs, and communication interfaces between the modules.

Please output the commands to generate this structure and provide the initial code for the most critical entry points (the WebSocket bridge, the webhook route, and the desktop app tray initialization).
