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
 * - `simple` — time crossfade over a fixed number of seconds; works for every
 *   source (local + SoundCloud).
 * - `beatmatch-sync` — both decks pitched to the target BPM; beatgrids aligned;
 *   fade spans a whole number of bars.
 * - `beatmatch-ramp` — deck B starts matched to deck A's current tempo, then
 *   both decks ramp continuously to the target BPM over the fade.
 */
export type MixMode = "simple" | "beatmatch-sync" | "beatmatch-ramp";

export interface MixConfig {
  /** Auto-mix into the next queued track near the end of the current one. */
  enabled: boolean;
  mode: MixMode;
  /** Fade length for the `simple` crossfade, in seconds (1–12). */
  simpleSeconds: number;
  /** Overlap length for the beatmatch modes, in bars. */
  matchBars: (typeof MATCH_BARS_STEPS)[number];
  /**
   * Snap beatmatch mix anchors to section boundaries (deck A's last section
   * end, deck B's end-of-intro) instead of a fixed offset from the file end —
   * so a few stray trailing bars don't smear the mix.
   */
  sectionAware: boolean;
}

export const SIMPLE_SECONDS_MIN = 1;
export const SIMPLE_SECONDS_MAX = 12;
export const MATCH_BARS_STEPS = [8, 16, 32] as const;

export const DEFAULT_MIX_CONFIG: MixConfig = {
  enabled: false,
  mode: "simple",
  simpleSeconds: 6,
  matchBars: 16,
  sectionAware: true,
};

/** UI-store key (see `lib/settings.ts`). */
export const MIX_CONFIG_KEY = "player.mixConfig";

export const MIX_MODE_LABELS: Record<MixMode, string> = {
  simple: "Simple",
  "beatmatch-sync": "Beatmatch — sync",
  "beatmatch-ramp": "Beatmatch — ramp",
};

export const MIX_MODE_DESCRIPTIONS: Record<MixMode, string> = {
  simple: "Fade between tracks over a fixed time. Works for any track.",
  "beatmatch-sync":
    "Align beatgrids with both tracks pitched to the target BPM. Needs a beatgrid.",
  "beatmatch-ramp":
    "Start the incoming track at the current tempo, then ramp both to the target BPM. Needs a beatgrid.",
};

/** Clamp a raw config into valid ranges (defensive against stale persistence). */
export function normalizeMixConfig(raw: Partial<MixConfig> | null): MixConfig {
  if (!raw) return { ...DEFAULT_MIX_CONFIG };
  const seconds = Number(raw.simpleSeconds);
  const bars = Number(raw.matchBars);
  return {
    enabled: !!raw.enabled,
    mode:
      raw.mode === "beatmatch-sync" ||
      raw.mode === "beatmatch-ramp" ||
      raw.mode === "simple"
        ? raw.mode
        : DEFAULT_MIX_CONFIG.mode,
    simpleSeconds: Number.isFinite(seconds)
      ? Math.min(SIMPLE_SECONDS_MAX, Math.max(SIMPLE_SECONDS_MIN, seconds))
      : DEFAULT_MIX_CONFIG.simpleSeconds,
    matchBars: (MATCH_BARS_STEPS as readonly number[]).includes(bars)
      ? (bars as MixConfig["matchBars"])
      : DEFAULT_MIX_CONFIG.matchBars,
    sectionAware: raw.sectionAware ?? DEFAULT_MIX_CONFIG.sectionAware,
  };
}
