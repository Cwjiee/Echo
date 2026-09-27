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
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from 'electron';
import { store } from './settings-store';
import { EchoWebSocketClient } from './websocket-client';
import { executeResolution } from './executor-bridge';

// ── App Configuration ──────────────────────────────────────────────────────
app.setName('echo-mac-agent');

// ── Suppress Dock icon (menu bar only app) ─────────────────────────────────
app.dock?.hide();

// ── Global references ──────────────────────────────────────────────────────
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let wsClient: EchoWebSocketClient | null = null;
let isConnected = false;

// ── App ready ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  initTray();
  registerIpcHandlers();

  if (store.get('autoConnect') && store.get('authToken')) {
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
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Echo Agent');
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;

  const statusLabel = isConnected ? '🟢 Connected' : '🔴 Disconnected';
  const connectLabel = isConnected ? 'Disconnect' : 'Connect to Server';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Echo Agent', enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: connectLabel,
      click: () => (isConnected ? disconnect() : connect()),
    },
    {
      label: '⚙️  Settings',
      click: openSettings,
    },
    { type: 'separator' },
    { label: 'Quit Echo Agent', role: 'quit' },
  ]);

  tray.setContextMenu(contextMenu);
}

// ── Connection management ──────────────────────────────────────────────────

function connect(): void {
  const backendUrl = store.get('backendUrl');
  const authToken = store.get('authToken');
  const workspace = store.get('workspace');

  if (!authToken) {
    openSettings();
    return;
  }

  wsClient = new EchoWebSocketClient({ url: backendUrl, token: authToken, workspace });

  wsClient.on('connected', () => {
    isConnected = true;
    updateTrayMenu();
    showNotification('Echo Agent', 'Connected to backend server.');
    settingsWindow?.webContents.send('agent:status', '🟢 Connected');
  });

  wsClient.on('disconnected', () => {
    isConnected = false;
    updateTrayMenu();
    settingsWindow?.webContents.send('agent:status', '🔴 Disconnected');
  });

  wsClient.on('approved_resolution', (payload) => {
    showNotification('Echo Agent', `Executing: ${payload.actions.join(', ')}`);
    void executeResolution(payload).then((results) => {
      wsClient?.sendApprovalResponse(payload.action_id, results);
    });
  });

  wsClient.connect();
}

function disconnect(): void {
  wsClient?.disconnect();
  wsClient = null;
  isConnected = false;
  updateTrayMenu();
}

// ── Settings Window ────────────────────────────────────────────────────────

function openSettings(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 420,
    title: 'Echo Agent Settings',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ── IPC Handlers ───────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => ({
    backendUrl: store.get('backendUrl'),
    authToken: store.get('authToken'),
    workspace: store.get('workspace'),
    autoConnect: store.get('autoConnect'),
  }));

  ipcMain.handle('settings:save', (_event, settings: Record<string, unknown>) => {
    if (typeof settings['backendUrl'] === 'string') store.set('backendUrl', settings['backendUrl']);
    if (typeof settings['authToken'] === 'string') store.set('authToken', settings['authToken']);
    if (typeof settings['workspace'] === 'string') store.set('workspace', settings['workspace']);
    if (typeof settings['autoConnect'] === 'boolean') store.set('autoConnect', settings['autoConnect']);
  });

  ipcMain.on('agent:connect', () => connect());
  ipcMain.on('agent:disconnect', () => disconnect());
}

// ── Helpers ────────────────────────────────────────────────────────────────

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}
