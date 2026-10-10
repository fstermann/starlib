/**
 * App-wide headphone sync: playheads and live visuals wait for the output
 * device's delay, so they match what you hear over Bluetooth. Audio timing
 * (mix points, cues, loops) keeps using the real clock; only drawing shifts.
 *
 * Module-level store so the top-bar toggle and every player read one value
 * without provider plumbing.
 */

import { useSyncExternalStore } from "react";

import { getRaw, setRaw } from "./settings";
import { isTauri, outputLatency } from "./tauri";

const STORAGE_KEY = "audio.headphoneSync";
const POLL_MS = 1000;

type State = { enabled: boolean; deviceLatency: number | null };

let state: State = { enabled: false, deviceLatency: null };
let loaded = false;
let poll: number | null = null;
const listeners = new Set<() => void>();

function update(change: Partial<State>): void {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}

async function readDeviceLatency(): Promise<void> {
  const seconds = await outputLatency().catch(() => null);
  if (seconds === state.deviceLatency) return;
  update({ deviceLatency: seconds });
}

// WebKit's own outputLatency doesn't fall back after leaving a Bluetooth
// device, so the app polls Core Audio to follow device switches.
function startPolling(): void {
  if (!isTauri() || poll !== null) return;
  void readDeviceLatency();
  poll = window.setInterval(() => void readDeviceLatency(), POLL_MS);
}

function stopPolling(): void {
  if (poll !== null) window.clearInterval(poll);
  poll = null;
}

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  void getRaw(STORAGE_KEY, false).then((on) => {
    if (!on) return;
    startPolling();
    update({ enabled: true });
  });
}

export function setHeadphoneSync(on: boolean): void {
  if (on) startPolling();
  else stopPolling();
  update({ enabled: on });
  void setRaw(STORAGE_KEY, on);
}

/**
 * Seconds that visuals driven by `ctx`'s clock should lag it; 0 when sync is
 * off. Uses the device latency from Core Audio in the app, else what the
 * browser reports for `ctx`.
 */
export function headphoneDelay(ctx?: BaseAudioContext | null): number {
  if (!state.enabled) return 0;
  const audio = ctx as AudioContext | null | undefined;
  return (
    (state.deviceLatency ?? audio?.outputLatency ?? 0) +
    (audio?.baseLatency ?? 0)
  );
}

/** React hook: the sync setting and the device latency, if known. */
export function useHeadphoneSync(): State {
  return useSyncExternalStore(
    (listener) => {
      load();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
