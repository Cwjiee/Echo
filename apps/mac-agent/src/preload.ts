/**
 * Electron preload script.
 * Exposes a safe, minimal API to the renderer process via contextBridge.
 * No Node.js APIs are exposed directly — all communication goes through IPC.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('echoAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:save', settings),
  connect: () => ipcRenderer.send('agent:connect'),
  disconnect: () => ipcRenderer.send('agent:disconnect'),
  onStatusChange: (callback: (status: string) => void) => {
    ipcRenderer.on('agent:status', (_event, status: string) => callback(status));
  },
});
