/**
 * Auto-mix (crossfade) configuration: the user-facing knobs and their
 * persistence. The engine and strategies consume this shape; the mix-controls
 * popover writes it.
 */

/**
 * Mix modes. Each maps to a pure strategy in `strategies.ts`. The list is a
 * registry — adding a future mode means adding a strategy + an entry here, with
 * no engine changes.
 *
 * - `crossfade` — time crossfade over a fixed number of seconds; works for
 *   every source (local + SoundCloud).
 * - `beatgrid` — bar-aligned blend on the beatgrids. With the BPM pitcher on
 *   (beat-sync to a common BPM) both decks are locked to the target BPM;
 *   with it off, the incoming deck enters at the current tempo and both decks
 *   ramp to the incoming track's own tempo over the fade (the pitcher target
 *   is ignored and the pitcher stays off).
 */
export type MixMode = "crossfade" | "beatgrid";

export interface MixConfig {
  /** Auto-mix into the next queued track near the end of the current one. */
  enabled: boolean;
  mode: MixMode;
  /** Fade length for the `crossfade` mode, in seconds (1–12). */
  crossfadeSeconds: number;
  /** Overlap length for the `beatgrid` mode, in bars. */
  matchBars: (typeof MATCH_BARS_STEPS)[number];
  /**
   * Snap beatgrid mix anchors to section boundaries (deck A's last section
   * end, deck B's end-of-intro) instead of a fixed offset from the file end —
   * so a few stray trailing bars don't smear the mix.
   */
  sectionAware: boolean;
}

export const CROSSFADE_SECONDS_MIN = 1;
export const CROSSFADE_SECONDS_MAX = 12;
export const MATCH_BARS_STEPS = [8, 16, 32] as const;

export const DEFAULT_MIX_CONFIG: MixConfig = {
  enabled: false,
  mode: "crossfade",
  crossfadeSeconds: 6,
  matchBars: 16,
  sectionAware: true,
};

/** UI-store key (see `lib/settings.ts`). */
export const MIX_CONFIG_KEY = "player.mixConfig";

export const MIX_MODE_LABELS: Record<MixMode, string> = {
  crossfade: "Crossfade",
  beatgrid: "Beatgrid",
};

export const MIX_MODE_DESCRIPTIONS: Record<MixMode, string> = {
  crossfade: "Fade between tracks over a fixed time. Works for any track.",
  beatgrid:
    "Align beatgrids for a bar-exact blend. Syncs both tracks to the target BPM when pitching is on, otherwise ramps the tempo across the fade. Needs a beatgrid.",
};

/** Clamp a raw config into valid ranges (defensive against stale persistence). */
export function normalizeMixConfig(raw: Partial<MixConfig> | null): MixConfig {
  if (!raw) return { ...DEFAULT_MIX_CONFIG };
  const seconds = Number(raw.crossfadeSeconds);
  const bars = Number(raw.matchBars);
  return {
    enabled: !!raw.enabled,
    mode:
      raw.mode === "crossfade" || raw.mode === "beatgrid"
        ? raw.mode
        : DEFAULT_MIX_CONFIG.mode,
    crossfadeSeconds: Number.isFinite(seconds)
      ? Math.min(
          CROSSFADE_SECONDS_MAX,
          Math.max(CROSSFADE_SECONDS_MIN, seconds),
        )
      : DEFAULT_MIX_CONFIG.crossfadeSeconds,
    matchBars: (MATCH_BARS_STEPS as readonly number[]).includes(bars)
      ? (bars as MixConfig["matchBars"])
      : DEFAULT_MIX_CONFIG.matchBars,
    sectionAware: raw.sectionAware ?? DEFAULT_MIX_CONFIG.sectionAware,
  };
}
