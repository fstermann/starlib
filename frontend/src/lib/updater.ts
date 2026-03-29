/**
 * Tauri auto-updater wrapper.
 * Checks for updates via the Tauri updater plugin and provides
 * install/restart functionality. No-ops gracefully outside Tauri.
 */

import { isTauri } from "./tauri";

export interface UpdateInfo {
  version: string;
  date: string | null;
  body: string | null;
}

export interface UpdateResult {
  available: boolean;
  update: UpdateInfo | null;
  /** Call to download and install the update, then relaunch. */
  install: (() => Promise<void>) | null;
}

export async function checkForUpdate(): Promise<UpdateResult> {
  if (!isTauri()) {
    return { available: false, update: null, install: null };
  }

  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");

  const result = await check();

  if (!result) {
    return { available: false, update: null, install: null };
  }

  return {
    available: true,
    update: {
      version: result.version,
      date: result.date ?? null,
      body: result.body ?? null,
    },
    install: async () => {
      await result.downloadAndInstall();
      await relaunch();
    },
  };
}
