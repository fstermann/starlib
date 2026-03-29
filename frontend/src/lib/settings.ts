/**
 * User settings store.
 * Uses Tauri Store plugin when running inside the desktop app,
 * falls back to localStorage in browser/dev.
 */

import { isTauri } from "./tauri";

export interface Settings {
  autoUpdate: boolean;
}

const DEFAULTS: Settings = {
  autoUpdate: true,
};

const STORAGE_KEY = "starlib_settings";

let storeInstance: Awaited<ReturnType<typeof import("@tauri-apps/plugin-store")["load"]>> | null = null;

async function getTauriStore() {
  if (storeInstance) return storeInstance;
  const { load } = await import("@tauri-apps/plugin-store");
  storeInstance = await load("settings.json", { autoSave: true, defaults: { ...DEFAULTS } as Record<string, unknown> });
  return storeInstance;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  if (isTauri()) {
    const store = await getTauriStore();
    const val = await store.get<Settings[K]>(key);
    return val ?? DEFAULTS[key];
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return parsed[key] ?? DEFAULTS[key];
    }
  } catch {
    // ignore
  }
  return DEFAULTS[key];
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  if (isTauri()) {
    const store = await getTauriStore();
    await store.set(key, value);
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const current: Partial<Settings> = raw ? JSON.parse(raw) : {};
    current[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
}
