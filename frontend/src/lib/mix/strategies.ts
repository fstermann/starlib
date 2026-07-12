/**
 * Mix strategies: pure functions that turn a {@link TransitionContext} (both
 * decks' analysis + the user's {@link MixConfig}) into a {@link TransitionPlan}
 * the engine executes. Kept side-effect-free so they're unit-testable and so a
 * future mix mode is just another `plan()` in the {@link STRATEGIES} registry.
 */

import type { MixConfig, MixMode } from "./config";
import { SIMPLE_SECONDS_MAX, SIMPLE_SECONDS_MIN } from "./config";

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
  config: MixConfig;
}

export interface TransitionPlan {
  /** Effective mode — may differ from `config.mode` after a no-grid fallback. */
  mode: MixMode;
  /** Whether a requested beatmatch fell back to `simple` (no usable grid). */
  fellBack: boolean;
  fadeSeconds: number;
  /** Playback time on deck A at which the fade begins. */
  deckAMixOutSec: number;
  /** Playback offset on deck B at which it starts. */
  deckBStartOffsetSec: number;
  /** playbackRate deck B starts at. */
  deckBInitialRate: number;
  /**
   * Continuous rate ramp over the fade (beatmatch-ramp only). Null means both
   * decks hold a constant rate for the whole transition.
   */
  rateRamp: {
    deckAFrom: number;
    deckATo: number;
    deckBFrom: number;
    deckBTo: number;
  } | null;
  gainCurve: "linear" | "equalPower";
}

/** Downbeat (bar start) at or before `timeSec`, else the first downbeat, else null. */
function downbeatAtOrBefore(beats: DeckBeat[], timeSec: number): number | null {
  let best: number | null = null;
  for (const b of beats) {
    if (b.beat !== 1) continue;
    if (b.timeSec <= timeSec) best = b.timeSec;
    else break;
  }
  if (best != null) return best;
  const first = beats.find((b) => b.beat === 1);
  return first ? first.timeSec : null;
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

/** Simple time crossfade — always applicable. */
function planSimple(ctx: TransitionContext, fellBack = false): TransitionPlan {
  const fade = Math.min(
    SIMPLE_SECONDS_MAX,
    Math.max(SIMPLE_SECONDS_MIN, ctx.config.simpleSeconds),
  );
  // Fade must fit inside deck A; never start before 0.
  const fadeSeconds = Math.min(fade, ctx.deckA.durationSec);
  return {
    mode: "simple",
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
 * Where deck A's mix-out should anchor: `matchBars` bars back from the end of
 * musical content. With `sectionAware`, "end of content" is the last section's
 * end (trims stray trailing bars); otherwise it's the file end. Snapped to a
 * downbeat so the overlap starts on a bar.
 */
function deckAMixOutAnchor(
  ctx: TransitionContext,
  fadeSeconds: number,
): number | null {
  const beats = ctx.deckA.analysis!.beats;
  const sections = ctx.deckA.analysis!.sections;
  let endRef = ctx.deckA.durationSec;
  if (ctx.config.sectionAware && sections.length > 0) {
    endRef = sections[sections.length - 1].endSec;
  }
  return downbeatAtOrBefore(beats, endRef - fadeSeconds);
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

/** Bars → seconds at a given BPM. */
function barsToSeconds(bars: number, bpm: number): number {
  return (bars * 4 * 60) / bpm;
}

/** Beatmatch with both decks locked to the target BPM. */
function planBeatmatchSync(ctx: TransitionContext): TransitionPlan {
  if (!hasGrid(ctx.deckA) || !hasGrid(ctx.deckB)) return planSimple(ctx, true);
  // Overlap length measured at the target tempo (what both decks play at).
  const fadeSeconds = barsToSeconds(ctx.config.matchBars, ctx.targetBpm);
  const mixOut = deckAMixOutAnchor(ctx, fadeSeconds);
  if (mixOut == null) return planSimple(ctx, true);
  const rateA = ctx.targetBpm / ctx.deckA.bpm!;
  const rateB = ctx.targetBpm / ctx.deckB.bpm!;
  return {
    mode: "beatmatch-sync",
    fellBack: false,
    // The fade plays at the target tempo, so scale the on-A duration by A's rate.
    fadeSeconds: fadeSeconds / rateA,
    deckAMixOutSec: mixOut,
    deckBStartOffsetSec: deckBMixInAnchor(ctx),
    deckBInitialRate: rateB,
    rateRamp: null,
    gainCurve: "equalPower",
  };
}

/**
 * Beatmatch with a continuous tempo ramp. Deck B enters matched to deck A's
 * current audible tempo, then both decks ramp to the target BPM over the fade.
 * Aligned at the start downbeat; the grids drift as the tempo ramps (a known
 * limitation — see the engine).
 */
function planBeatmatchRamp(ctx: TransitionContext): TransitionPlan {
  if (!hasGrid(ctx.deckA) || !hasGrid(ctx.deckB)) return planSimple(ctx, true);
  const audibleBpmA = ctx.deckA.bpm! * ctx.deckACurrentRate;
  // Fade length measured at deck A's current audible tempo.
  const fadeAtTempo = barsToSeconds(ctx.config.matchBars, audibleBpmA);
  const fadeSeconds = fadeAtTempo / ctx.deckACurrentRate;
  const mixOut = deckAMixOutAnchor(ctx, fadeSeconds);
  if (mixOut == null) return planSimple(ctx, true);
  const rateAFrom = ctx.deckACurrentRate;
  const rateATo = ctx.targetBpm / ctx.deckA.bpm!;
  // Deck B enters at whatever rate makes it audible at deck A's current tempo.
  const rateBFrom = audibleBpmA / ctx.deckB.bpm!;
  const rateBTo = ctx.targetBpm / ctx.deckB.bpm!;
  return {
    mode: "beatmatch-ramp",
    fellBack: false,
    fadeSeconds,
    deckAMixOutSec: mixOut,
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
    simple: (ctx) => planSimple(ctx),
    "beatmatch-sync": planBeatmatchSync,
    "beatmatch-ramp": planBeatmatchRamp,
  };

/** Build the transition plan for the configured mode (with no-grid fallback). */
export function planTransition(ctx: TransitionContext): TransitionPlan {
  return STRATEGIES[ctx.config.mode](ctx);
}
