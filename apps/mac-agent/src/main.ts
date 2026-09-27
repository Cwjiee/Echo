/**
 * Echo Mac Agent — Electron Main Process
 *
 * Creates a menu bar tray application that:
 *  1. Shows a tray icon with connection status indicator.
 *  2. Opens a settings window to configure Backend URL, Auth Token, and Workspace.
 *  3. Maintains a persistent Socket.IO connection to the Echo backend.
 *  4. Receives 'approved_resolution' events and delegates to @echo/local-executor.
 */

import path from 'path';
import dotenv from 'dotenv';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from 'electron';

// Load .env files: local mac-agent .env, fallback to root .env
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../../../.env') });
dotenv.config();

import { store } from './settings-store';
import { EchoWebSocketClient } from './websocket-client';
import { executeResolution } from './executor-bridge';
import type { ApplyRequest } from '@echo/local-executor';

// action_id → local head_sha recorded at inspect time (CONTRACT step 4).
// Keyed by action_id; entry is read once when approved_resolution arrives.
const inspectCache = new Map<string, string>();

// ── App Configuration ──────────────────────────────────────────────────────
app.setName('echo-mac-agent');

// ── Suppress Dock icon (menu bar only app) ─────────────────────────────────
app.dock?.hide();

// ── Global references ──────────────────────────────────────────────────────
let tray: Tray | null = null;
let homeWindow: BrowserWindow | null = null;
let wsClient: EchoWebSocketClient | null = null;
let isConnected = false;

// In-memory session list pushed to the home renderer.
interface Session {
  id: string;
  title: string;
  repo: string;
  branch: string;
  status: 'running' | 'done' | 'failed';
  started: string;
  approvedBy: string;
  group: string;
  age: string;
  log: Array<{ cmd?: string; status?: string; output?: string; ms?: number; note?: string; summary?: string; failed?: boolean }>;
}
const sessions: Session[] = [];

function pushSessions(): void {
  homeWindow?.webContents.send('agent:sessions', sessions);
}

// ── App ready ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  initTray();
  registerIpcHandlers();
  openHome();

  if (store.get('autoConnect')) {
    connect();
  }
});

// Prevent app from quitting when all windows are closed (tray app lifecycle)
app.on('window-all-closed', () => {
  // macOS tray apps stay alive when windows close
});

// ── Tray ───────────────────────────────────────────────────────────────────

function initTray(): void {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    icon.setTemplateImage(true);
    tray = new Tray(icon);
  } else {
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('⚡ Echo');
  }
  tray.setToolTip('Echo Agent');
  // Left click opens the Echo window; right click keeps the quick menu.
  tray.on('click', openHome);
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()));
}

function buildTrayMenu(): Menu {
  const statusLabel = isConnected ? '🟢 Connected' : '🔴 Disconnected';
  const connectLabel = isConnected ? 'Disconnect' : 'Connect to Server';

  return Menu.buildFromTemplate([
    { label: 'Echo Agent', enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: connectLabel,
      click: () => (isConnected ? disconnect() : connect()),
    },
    {
      label: 'Open Echo',
      click: openHome,
    },
    { type: 'separator' },
    { label: 'Quit Echo Agent', role: 'quit' },
  ]);
}

// ── Connection management ──────────────────────────────────────────────────

function connect(): void {
  const backendUrl = process.env.BACKEND_URL || store.get('backendUrl') || 'http://localhost:8000';
  const authToken = process.env.AGENT_TOKEN || '';
  const workspace = process.env.WORKSPACE || 'default';

  wsClient = new EchoWebSocketClient({ url: backendUrl, token: authToken, workspace });

  wsClient.on('connected', () => {
    isConnected = true;
    showNotification('Echo Agent', 'Connected to backend server.');
    homeWindow?.webContents.send('agent:status', '🟢 Connected');
  });

  wsClient.on('disconnected', () => {
    isConnected = false;
    homeWindow?.webContents.send('agent:status', '🔴 Disconnected');
  });

  // CONTRACT step 4: run inspect() as soon as the analysis arrives so that
  // head_sha is ready (and fresh) by the time the developer approves.
  wsClient.on('github_event', (data: { event_type: string; analysis: { action_id: string; context?: { repository?: string } } }) => {
    const { action_id, context } = data.analysis ?? {};
    const repository = context?.repository ?? '';
    if (action_id && repository) {
      void runInspect(action_id, repository);
    }
  });

  wsClient.on('approved_resolution', (payload) => {
    showNotification('Echo Agent', `Executing: ${payload.actions.join(', ')}`);
    void runApply(payload);
  });

  wsClient.connect();
}

function disconnect(): void {
  wsClient?.disconnect();
  wsClient = null;
  isConnected = false;
}

// ── Home Window ────────────────────────────────────────────────────────────

function openHome(): void {
  if (homeWindow) {
    homeWindow.show();
    homeWindow.focus();
    return;
  }

  homeWindow = new BrowserWindow({
    width: 840,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    title: 'Echo',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#1f1f2d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  homeWindow.loadFile(path.join(__dirname, '../renderer/home.html'));
  homeWindow.once('ready-to-show', () => {
    homeWindow?.show();
    // Sync current state into the freshly loaded renderer.
    homeWindow?.webContents.send('agent:status', isConnected ? '🟢 Connected' : '🔴 Disconnected');
    pushSessions();
  });

  homeWindow.on('closed', () => {
    homeWindow = null;
  });
}

// ── IPC Handlers ───────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => ({
    backendUrl: process.env.BACKEND_URL || store.get('backendUrl') || 'http://localhost:8000',
    autoConnect: store.get('autoConnect'),
  }));

  ipcMain.handle('settings:save', (_event, settings: Record<string, unknown>) => {
    if (typeof settings['backendUrl'] === 'string') store.set('backendUrl', settings['backendUrl']);
    if (typeof settings['autoConnect'] === 'boolean') store.set('autoConnect', settings['autoConnect']);
  });

  ipcMain.handle('agent:connection-state', () => isConnected);

  ipcMain.on('agent:connect', () => connect());
  ipcMain.on('agent:disconnect', () => disconnect());
}

// ── Helpers ────────────────────────────────────────────────────────────────

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ── Inspect → Apply pipeline (CONTRACT steps 4 & 7) ───────────────────────
//
// Step 4 (on github_event): run inspect() immediately, cache head_sha locally.
// Step 7 (on approved_resolution): read cached sha, call apply().
//
// This keeps inspect off the critical approval path so apply() runs without
// a blocking git fetch after the developer has already waited for the AI summary.

async function runInspect(actionId: string, repository: string): Promise<void> {
  const { inspect } = await import('@echo/local-executor');
  try {
    const report = await inspect({
      protocol_version: 1,
      request_id: actionId,
      repository,
    });
    inspectCache.set(actionId, report.head_sha);
    console.log(`[inspector] cached head_sha=${report.head_sha} for action_id=${actionId}`);
  } catch (err) {
    console.error(`[inspector] inspect() failed for ${repository}:`, err);
    // Cache empty string so runApply knows inspect was attempted but failed.
    inspectCache.set(actionId, '');
  }
}

async function runApply(payload: ApplyRequest): Promise<void> {
  const actionId = payload.action_id;
  const repo = payload.repository;
  const now = new Date();

  // Create a running session entry immediately so the UI updates.
  const session: Session = {
    id: actionId,
    title: `Sync ${repo.split('/')[1] ?? repo}`,
    repo,
    branch: payload.context?.branch ?? 'main',
    status: 'running',
    started: now.toLocaleTimeString(),
    approvedBy: (payload.context as Record<string, string> | undefined)?.approved_by ?? 'discord',
    group: now.toLocaleDateString(),
    age: 'just now',
    log: [{ note: `Starting sync for ${repo}` }],
  };
  sessions.unshift(session);
  pushSessions();

  // Read head_sha from cache. If inspect hasn't finished yet, run it now.
  let headSha = inspectCache.get(actionId);
  if (headSha === undefined) {
    console.warn(`[executor] head_sha not cached yet for ${actionId}, running inspect now`);
    await runInspect(actionId, repo);
    headSha = inspectCache.get(actionId) ?? '';
  }

  if (!headSha) {
    console.error(`[executor] no valid head_sha for ${actionId} — aborting`);
    session.status = 'failed';
    session.log.push({ summary: 'Could not resolve local repository HEAD. Check ~/.echo/config.json', failed: true });
    pushSessions();
    wsClient?.sendApprovalResponse(actionId, []);
    inspectCache.delete(actionId);
    return;
  }

  inspectCache.delete(actionId); // consume — idempotency cache in apply() handles replays

  const fullPayload: ApplyRequest = { ...payload, base_sha: headSha };

  try {
    const result = await executeResolution(fullPayload);

    // Update session log from execution results.
    session.log = result.results.map((r) => ({
      cmd: r.action,
      status: r.success ? 'done' : 'failed',
      output: [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || undefined,
      ms: r.durationMs,
    }));

    if (result.rolled_back) {
      session.log.push({ note: '⚠️ Changes rolled back due to failure.' });
    }
    if (result.stash_retained) {
      session.log.push({ note: `⚠️ Stash retained: ${result.stash_retained.reason}` });
    }

    session.status = result.status === 'success' ? 'done' : 'failed';
    if (result.error) {
      session.log.push({ summary: `Error: ${result.error}${result.error_detail ? ` — ${result.error_detail}` : ''}`, failed: true });
    }
    pushSessions();

    wsClient?.sendApprovalResponse(actionId, result.results);
  } catch (error: unknown) {
    console.error(`[executor] ${actionId} failed before execution:`, error);
    session.status = 'failed';
    session.log.push({ summary: String(error), failed: true });
    pushSessions();
    wsClient?.sendApprovalResponse(actionId, []);
  }
}
