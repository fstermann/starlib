/**
 * User settings store.
 * Uses Tauri Store plugin when running inside the desktop app,
 * falls back to localStorage in browser/dev.
 */

import { isTauri } from "./tauri";

/** Which waveform the bottom player renders for Rekordbox tracks. */
export type WaveformStyle = "starlib" | "rekordbox_rgb" | "rekordbox_blue";

export interface Settings {
  autoUpdate: boolean;
  preferredOutputFormat: "aiff" | "mp3";
  waveformStyle: WaveformStyle;
}

const DEFAULTS: Settings = {
  autoUpdate: true,
  preferredOutputFormat: "aiff",
  waveformStyle: "starlib",
};

const STORAGE_KEY = "starlib_settings";

let storeInstance: Awaited<
  ReturnType<(typeof import("@tauri-apps/plugin-store"))["load"]>
> | null = null;

async function getTauriStore() {
  if (storeInstance) return storeInstance;
  const { load } = await import("@tauri-apps/plugin-store");
  storeInstance = await load("settings.json", {
    autoSave: true,
    defaults: { ...DEFAULTS } as Record<string, unknown>,
  });
  return storeInstance;
}

export async function getSetting<K extends keyof Settings>(
  key: K,
): Promise<Settings[K]> {
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

/**
 * Feature-scoped persistent value. Use for per-view preferences (column
 * visibility, etc.) that don't warrant a slot on the `Settings` type.
 * Keys should be namespaced, e.g. `columns.library.filesystem`.
 */
export async function getRaw<T>(key: string, fallback: T): Promise<T> {
  if (isTauri()) {
    const store = await getTauriStore();
    const val = await store.get<T>(key);
    return val ?? fallback;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const val = parsed[key];
      if (val !== undefined) return val as T;
    }
  } catch {
    // ignore
  }
  return fallback;
}

export async function setRaw<T>(key: string, value: T): Promise<void> {
  if (isTauri()) {
    const store = await getTauriStore();
    await store.set(key, value);
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const current: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    current[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
}
