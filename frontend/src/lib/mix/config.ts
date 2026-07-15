/**
 * Auto-mix (crossfade) configuration: the user-facing knobs and their
 * persistence. The engine and strategies consume this shape; the mix-controls
 * popover writes it.
 */

import { ArrowRightLeft, Grid2x2, Repeat, SlidersVertical } from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
 * - `beatgrid-eq` — the beatgrid blend plus a DJ-style bass swap: the incoming
 *   deck's bass is killed for most of the fade, then in the last 2 bars the
 *   bass swaps (outgoing deck's bass kills, incoming deck's returns full) so the
 *   two basslines never clash. Local decks only (SoundCloud can't be EQ'd).
 * - `loop-eq` — a full DJ-mixer transition: loop the outgoing deck's first 4
 *   bars, blend the incoming deck in band-by-band with a 3-band EQ (highs → mids
 *   → bass hard-swap) over `matchBars` bars, then fade the outgoing deck out
 *   underneath over another `matchBars` bars. Local decks only.
 */
export type MixMode = "crossfade" | "beatgrid" | "beatgrid-eq" | "loop-eq";

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
  "beatgrid-eq": "Beatgrid + EQ",
  "loop-eq": "Loop + EQ",
};

export const MIX_MODE_ICONS: Record<MixMode, LucideIcon> = {
  crossfade: ArrowRightLeft,
  beatgrid: Grid2x2,
  "beatgrid-eq": SlidersVertical,
  "loop-eq": Repeat,
};

export const MIX_MODE_DESCRIPTIONS: Record<MixMode, string> = {
  crossfade: "Fade between tracks over a fixed time. Works for any track.",
  beatgrid:
    "Align beatgrids for a bar-exact blend. Syncs both tracks to the target BPM when pitching is on, otherwise ramps the tempo across the fade. Needs a beatgrid.",
  "beatgrid-eq":
    "Beatgrid blend with a DJ bass swap: the incoming bass stays cut until the last 2 bars, then the bass kills on the outgoing track and swings in full on the incoming one. Local tracks only.",
  "loop-eq":
    "Full DJ-mixer blend: loop the outgoing track and mix the incoming one in band-by-band (highs, mids, then a bass drop), then fade the outgoing track out underneath. Local tracks only.",
};

/** Clamp a raw config into valid ranges (defensive against stale persistence). */
export function normalizeMixConfig(raw: Partial<MixConfig> | null): MixConfig {
  if (!raw) return { ...DEFAULT_MIX_CONFIG };
  const seconds = Number(raw.crossfadeSeconds);
  const bars = Number(raw.matchBars);
  return {
    enabled: !!raw.enabled,
    mode:
      raw.mode === "crossfade" ||
      raw.mode === "beatgrid" ||
      raw.mode === "beatgrid-eq" ||
      raw.mode === "loop-eq"
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
