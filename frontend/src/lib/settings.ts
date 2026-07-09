/**
 * Client/UI preferences store. Owns presentation-only state (window/UI prefs)
 * that never needs to reach the Python backend and must survive the backend
 * being down or still booting.
 *
 * Persists to its OWN file (`ui.json`) — the backend owns `settings.json` in the
 * same config dir, so the two must never share a filename. Uses the Tauri Store
 * plugin inside the desktop app, falls back to localStorage in browser/dev.
 *
 * Domain/path config (root music folder, rulesets, folders, output format, AI)
 * is owned by the backend and read/written via `lib/api.ts`, not here.
 */

import { isTauri } from "./tauri";

/** Which waveform the bottom player renders for Rekordbox tracks. */
export type WaveformStyle = "starlib" | "rekordbox_rgb" | "rekordbox_blue";

export interface Settings {
  autoUpdate: boolean;
  waveformStyle: WaveformStyle;
}

const DEFAULTS: Settings = {
  autoUpdate: true,
  waveformStyle: "starlib",
};

const STORAGE_KEY = "starlib_ui";

const UI_STORE_FILE = "ui.json";
/** Legacy file the UI store shared with the backend — read once to migrate. */
const LEGACY_STORE_FILE = "settings.json";

let storeInstance: Awaited<
  ReturnType<(typeof import("@tauri-apps/plugin-store"))["load"]>
> | null = null;

async function getTauriStore() {
  if (storeInstance) return storeInstance;
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load(UI_STORE_FILE, {
    autoSave: true,
    defaults: { ...DEFAULTS } as Record<string, unknown>,
  });
  await migrateFromLegacyStore(store);
  storeInstance = store;
  return storeInstance;
}

/**
 * One-time move of UI keys out of the legacy `settings.json` (which the backend
 * also writes) into `ui.json`. Reads the old file but never writes to it, so the
 * backend's keys are left untouched. Runs until the marker key is set.
 */
async function migrateFromLegacyStore(
  store: Awaited<ReturnType<typeof getTauriStore>>,
): Promise<void> {
  const MARKER = "__ui_migrated";
  if (await store.get(MARKER)) return;
  try {
    const { load } = await import("@tauri-apps/plugin-store");
    const legacy = await load(LEGACY_STORE_FILE, {
      autoSave: false,
      defaults: {},
    });
    for (const key of await legacy.keys()) {
      // Only carry over UI-owned keys; leave backend keys (app, rulesets, …).
      const isUiKey =
        key === "autoUpdate" ||
        key === "waveformStyle" ||
        key.startsWith("columns.");
      if (isUiKey && (await store.get(key)) === undefined) {
        await store.set(key, await legacy.get(key));
      }
    }
  } catch {
    // No legacy file / not in Tauri — nothing to migrate.
  }
  await store.set(MARKER, true);
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
