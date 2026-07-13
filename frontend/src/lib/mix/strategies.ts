/**
 * Mix strategies: pure functions that turn a {@link TransitionContext} (both
 * decks' analysis + the user's {@link MixConfig}) into a {@link TransitionPlan}
 * the engine executes. Kept side-effect-free so they're unit-testable and so a
 * future mix mode is just another `plan()` in the {@link STRATEGIES} registry.
 */

import type { MixConfig, MixMode } from "./config";
import { CROSSFADE_SECONDS_MAX, CROSSFADE_SECONDS_MIN } from "./config";

/** One beatgrid entry, in seconds, with its position in the bar (1–4). */
export interface DeckBeat {
  timeSec: number;
  beat: number;
}

export interface DeckSection {
  startSec: number;
  endSec: number;
  kind: string;
}

export interface DeckAnalysis {
  /** Beatgrid, ascending by time. Empty when the track has no grid. */
  beats: DeckBeat[];
  sections: DeckSection[];
}

export interface DeckInfo {
  bpm: number | null;
  durationSec: number;
  analysis: DeckAnalysis | null;
}

export interface TransitionContext {
  deckA: DeckInfo;
  deckB: DeckInfo;
  /** Deck A's current audible playback rate (out-going deck). */
  deckACurrentRate: number;
  /** Rate the pitcher would apply to each deck on its own (target/bpm, clamped). */
  deckADesiredRate: number;
  deckBDesiredRate: number;
  /** Global pitcher target BPM. */
  targetBpm: number;
  /**
   * Whether the BPM pitcher is active (beat-sync to a common BPM). Picks the
   * beatgrid variant: locked to the target BPM when on, tempo ramp when off.
   */
  beatSync: boolean;
  config: MixConfig;
}

export interface TransitionPlan {
  /** Effective mode — may differ from `config.mode` after a no-grid fallback. */
  mode: MixMode;
  /** Whether a requested beatgrid mix fell back to `crossfade` (no usable grid). */
  fellBack: boolean;
  fadeSeconds: number;
  /** Playback time on deck A at which the fade begins. */
  deckAMixOutSec: number;
  /** Playback offset on deck B at which it starts. */
  deckBStartOffsetSec: number;
  /** playbackRate deck B starts at. */
  deckBInitialRate: number;
  /**
   * Continuous rate ramp over the fade (beatgrid without beat-sync only).
   * Null means both decks hold a constant rate for the whole transition.
   */
  rateRamp: {
    deckAFrom: number;
    deckATo: number;
    deckBFrom: number;
    deckBTo: number;
  } | null;
  gainCurve: "linear" | "equalPower";
}

/** First downbeat at or after `timeSec`, else the last downbeat, else null. */
function downbeatAtOrAfter(beats: DeckBeat[], timeSec: number): number | null {
  for (const b of beats) {
    if (b.beat === 1 && b.timeSec >= timeSec) return b.timeSec;
  }
  for (let i = beats.length - 1; i >= 0; i--) {
    if (beats[i].beat === 1) return beats[i].timeSec;
  }
  return null;
}

function hasGrid(info: DeckInfo): boolean {
  return (
    !!info.analysis &&
    info.analysis.beats.length > 0 &&
    !!info.bpm &&
    info.bpm > 0
  );
}

/** Plain time crossfade — always applicable. */
function planCrossfade(
  ctx: TransitionContext,
  fellBack = false,
): TransitionPlan {
  const fade = Math.min(
    CROSSFADE_SECONDS_MAX,
    Math.max(CROSSFADE_SECONDS_MIN, ctx.config.crossfadeSeconds),
  );
  // Fade must fit inside deck A; never start before 0.
  const fadeSeconds = Math.min(fade, ctx.deckA.durationSec);
  return {
    mode: "crossfade",
    fellBack,
    fadeSeconds,
    deckAMixOutSec: Math.max(0, ctx.deckA.durationSec - fadeSeconds),
    deckBStartOffsetSec: 0,
    deckBInitialRate: ctx.deckBDesiredRate,
    rateRamp: null,
    gainCurve: "equalPower",
  };
}

/**
 * Deck A's mix-out window: `matchBars` bars back from the end of musical
 * content. With `sectionAware`, "end of content" is the last section's end
 * (trims stray trailing bars); otherwise it's the file end.
 *
 * Anchored by walking deck A's own beatgrid: take the downbeat at or before
 * the content end, then step `matchBars` downbeats back through the grid. Both
 * ends land exactly on grid ticks, so the fade finishes bar-perfect at the
 * content end even when tick times are ms-rounded or the grid drifts —
 * deriving the start by subtracting a computed fade length and re-snapping to
 * a downbeat was reliably a bar early.
 */
function deckAMixOutWindow(
  ctx: TransitionContext,
): { mixOutSec: number; fadeOnASec: number } | null {
  const { beats, sections } = ctx.deckA.analysis!;
  let endRef = ctx.deckA.durationSec;
  if (ctx.config.sectionAware && sections.length > 0) {
    endRef = sections[sections.length - 1].endSec;
  }
  const downbeats = beats.filter((b) => b.beat === 1);
  let endIdx = -1;
  for (let i = 0; i < downbeats.length; i++) {
    if (downbeats[i].timeSec <= endRef) endIdx = i;
    else break;
  }
  if (endIdx <= 0) return null;
  const startIdx = Math.max(0, endIdx - ctx.config.matchBars);
  const fadeOnASec = downbeats[endIdx].timeSec - downbeats[startIdx].timeSec;
  if (fadeOnASec <= 0) return null;
  return { mixOutSec: downbeats[startIdx].timeSec, fadeOnASec };
}

/**
 * Where deck B starts. With `sectionAware`, skip a leading `intro` section
 * (start at its end); otherwise start at the first downbeat.
 */
function deckBMixInAnchor(ctx: TransitionContext): number {
  const beats = ctx.deckB.analysis!.beats;
  const sections = ctx.deckB.analysis!.sections;
  if (ctx.config.sectionAware && sections.length > 0) {
    const first = sections[0];
    if (first.kind === "intro") {
      const db = downbeatAtOrAfter(beats, first.endSec);
      if (db != null) return db;
    }
  }
  const first = downbeatAtOrAfter(beats, 0);
  return first ?? 0;
}

/**
 * Beatgrid mix. With `beatSync` (the BPM pitcher active) both decks are locked
 * to the target BPM and the grids stay aligned for the whole fade. Without it,
 * the pitcher target is ignored: deck B enters matched to deck A's current
 * audible tempo, then both decks ramp continuously to deck B's own tempo over
 * the fade (deck A bends to meet it; deck B ends at its natural rate) — aligned
 * at the start downbeat; the grids drift as the tempo ramps (a known
 * limitation — see the engine).
 */
function planBeatgrid(ctx: TransitionContext): TransitionPlan {
  if (!hasGrid(ctx.deckA) || !hasGrid(ctx.deckB))
    return planCrossfade(ctx, true);
  const win = deckAMixOutWindow(ctx);
  if (win == null) return planCrossfade(ctx, true);
  if (ctx.beatSync) {
    const rateA = ctx.targetBpm / ctx.deckA.bpm!;
    const rateB = ctx.targetBpm / ctx.deckB.bpm!;
    return {
      mode: "beatgrid",
      fellBack: false,
      // The window is measured on deck A's own grid; played at `rateA` it
      // spans exactly `matchBars` bars at the target tempo.
      fadeSeconds: win.fadeOnASec / rateA,
      deckAMixOutSec: win.mixOutSec,
      deckBStartOffsetSec: deckBMixInAnchor(ctx),
      deckBInitialRate: rateB,
      rateRamp: null,
      gainCurve: "equalPower",
    };
  }
  const audibleBpmA = ctx.deckA.bpm! * ctx.deckACurrentRate;
  const rateAFrom = ctx.deckACurrentRate;
  // Beat-sync is off, so the pitcher target plays no role: the incoming track
  // wins. Deck A bends to meet deck B's own tempo and deck B lands at its
  // natural rate, so the fade ends with the pitcher untouched — no snap to the
  // target BPM and no auto-enabling the pitcher after adoption.
  const rateATo = ctx.deckB.bpm! / ctx.deckA.bpm!;
  // Deck A's rate ramps linearly from → to across the fade, so it consumes its
  // grid window at the average of the two rates.
  const fadeSeconds = win.fadeOnASec / ((rateAFrom + rateATo) / 2);
  // Deck B enters at whatever rate makes it audible at deck A's current tempo.
  const rateBFrom = audibleBpmA / ctx.deckB.bpm!;
  const rateBTo = 1;
  return {
    mode: "beatgrid",
    fellBack: false,
    fadeSeconds,
    deckAMixOutSec: win.mixOutSec,
    deckBStartOffsetSec: deckBMixInAnchor(ctx),
    deckBInitialRate: rateBFrom,
    rateRamp: {
      deckAFrom: rateAFrom,
      deckATo: rateATo,
      deckBFrom: rateBFrom,
      deckBTo: rateBTo,
    },
    gainCurve: "equalPower",
  };
}

const STRATEGIES: Record<MixMode, (ctx: TransitionContext) => TransitionPlan> =
  {
    crossfade: (ctx) => planCrossfade(ctx),
    beatgrid: planBeatgrid,
  };

/** Build the transition plan for the configured mode (with no-grid fallback). */
export function planTransition(ctx: TransitionContext): TransitionPlan {
  return STRATEGIES[ctx.config.mode](ctx);
}
