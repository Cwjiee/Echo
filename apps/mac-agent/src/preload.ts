/**
 * Electron preload script.
 * Exposes a safe, minimal API to the renderer process via contextBridge.
 * No Node.js APIs are exposed directly — all communication goes through IPC.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('echoAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:save', settings),

  // Connection
  connect: () => ipcRenderer.send('agent:connect'),
  disconnect: () => ipcRenderer.send('agent:disconnect'),

  // Status updates: main → renderer
  onStatusChange: (callback: (status: string) => void) => {
    ipcRenderer.on('agent:status', (_event, status: string) => callback(status));
  },

  // Session updates: main → renderer (Activity view)
  onSessionsChange: (callback: (sessions: unknown[]) => void) => {
    ipcRenderer.on('agent:sessions', (_event, sessions: unknown[]) => callback(sessions));
  },

  // Connection state query (so renderer can sync on load)
  getConnectionState: () => ipcRenderer.invoke('agent:connection-state'),
});
