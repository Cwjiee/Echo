import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface SettingsSchema {
  backendUrl: string;
  autoConnect: boolean;
}

const DEFAULT_SETTINGS: SettingsSchema = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:8000',
  autoConnect: false,
};

export class SettingsStore {
  private filePath: string | null = null;
  private data: SettingsSchema = { ...DEFAULT_SETTINGS };

  private ensureLoaded(): void {
    if (this.filePath) return;
    try {
      const userData = app.getPath('userData');
      this.filePath = path.join(userData, 'settings.json');
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch {
      this.data = { ...DEFAULT_SETTINGS };
    }
  }

  get<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
    this.ensureLoaded();
    return this.data[key];
  }

  set<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void {
    this.ensureLoaded();
    this.data[key] = value;
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch (err) {
        console.error('[store] Failed to save settings:', err);
      }
    }
  }
}

export const store = new SettingsStore();
