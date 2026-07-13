/**
 * The dual-deck mix engine. It owns the *incoming* deck (deck B) during an
 * auto-mix, runs the gain (and, for the ramp mode, tempo) automation on the
 * shared `AudioContext` clock, then hands deck B off to the rebuilt
 * `WaveformPlayer` so playback continues without a gap.
 *
 * The engine is deliberately small: strategy planning lives in `strategies.ts`
 * (pure), and lifecycle/orchestration lives in `WaveformPlayer` (which already
 * manages the delicate single-deck teardown). The engine is the audio-graph
 * primitive layer in between.
 */

import {
  getSharedAudioContext,
  LoopingWebAudioPlayer,
} from "@/lib/looping-web-audio-player";

import {
  createHtmlDeck,
  type GainParamLike,
  type HtmlGainRoute,
} from "./html-deck";
import type { TransitionPlan } from "./strategies";

/** A playable deck, unifying the local (Web Audio) and SoundCloud (element)
 * paths behind the operations the engine and the hand-off need. */
export interface Deck {
  readonly kind: "local" | "html";
  /** The media WaveSurfer binds to after adoption. */
  readonly media: HTMLAudioElement | LoopingWebAudioPlayer;
  readonly duration: number;
  /** Current playback position in seconds (for the incoming playhead). */
  readonly currentTime: number;
  play(): void;
  pause(): void;
  setCurrentTime(sec: number): void;
  setRate(rate: number): void;
  /** The gain automation to crossfade — a real `AudioParam` for local decks,
   * an `element.volume` driver for element decks. */
  readonly gainParam: GainParamLike;
  /** The tempo `AudioParam` for ramp mode, or null (element decks can't ramp). */
  rateParam(): AudioParam | null;
  destroy(): void;
}

/** Wrap a local Web Audio player as a deck. */
export function localDeck(player: LoopingWebAudioPlayer): Deck {
  return {
    kind: "local",
    media: player,
    get duration() {
      return player.duration;
    },
    get currentTime() {
      return player.currentTime;
    },
    play: () => void player.play().catch(() => {}),
    pause: () => player.pause(),
    setCurrentTime: (sec) => {
      player.currentTime = sec;
    },
    setRate: (rate) => {
      player.playbackRate = rate;
    },
    get gainParam() {
      return player.getGainParam();
    },
    rateParam: () => player.getRateParam(),
    destroy: () => player.destroy(),
  };
}

/** Wrap a SoundCloud element (+ its gain route) as a deck. */
export function htmlDeck(audio: HTMLAudioElement, route: HtmlGainRoute): Deck {
  return {
    kind: "html",
    media: audio,
    get duration() {
      return isFinite(audio.duration) ? audio.duration : 0;
    },
    get currentTime() {
      return audio.currentTime;
    },
    play: () => void audio.play().catch(() => {}),
    pause: () => audio.pause(),
    setCurrentTime: (sec) => {
      try {
        audio.currentTime = sec;
      } catch {
        /* not seekable yet */
      }
    },
    setRate: (rate) => {
      audio.preservesPitch = false;
      audio.playbackRate = rate;
    },
    get gainParam() {
      return route.gainParam;
    },
    // Element playbackRate is not an AudioParam — no sample-accurate ramp.
    rateParam: () => null,
    destroy: () => {
      audio.pause();
      route.dispose();
      audio.src = "";
      audio.remove();
    },
  };
}

/** Build an incoming SoundCloud deck B from a resolved stream URL (starts silent). */
export async function createIncomingHtmlDeck(url: string): Promise<Deck> {
  const src = await createHtmlDeck(url, 0);
  return htmlDeck(src.audio, src.route);
}

/** Build an incoming local deck B from a source URL (decodes the buffer). */
export async function createIncomingLocalDeck(url: string): Promise<Deck> {
  const player = new LoopingWebAudioPlayer();
  await player.loadBuffer(url);
  // Start silent; the fade brings it in.
  player.getGainParam().value = 0;
  return localDeck(player);
}

// --- gain curves ---------------------------------------------------------

const CURVE_STEPS = 64;

/** Equal-power fade curve (constant perceived loudness through the mix). */
function equalPowerCurve(from: number, to: number): Float32Array {
  const c = new Float32Array(CURVE_STEPS);
  for (let i = 0; i < CURVE_STEPS; i++) {
    const t = i / (CURVE_STEPS - 1);
    // cos/sin quarter-turn between the endpoints.
    c[i] = from + (to - from) * Math.sin((t * Math.PI) / 2);
  }
  return c;
}

function rampGain(
  param: GainParamLike,
  ctx: AudioContext,
  from: number,
  to: number,
  seconds: number,
  curve: TransitionPlan["gainCurve"],
): void {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  if (curve === "equalPower") {
    param.setValueCurveAtTime(equalPowerCurve(from, to), now, seconds);
  } else {
    param.linearRampToValueAtTime(to, now + seconds);
  }
}

function rampRate(
  param: AudioParam,
  ctx: AudioContext,
  from: number,
  to: number,
  seconds: number,
): void {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.linearRampToValueAtTime(to, now + seconds);
}

// --- transition runner ---------------------------------------------------

export interface TransitionHandle {
  cancel(): void;
  /** Freeze the fade: pause both decks and hold the gain/rate automation. */
  pause(): void;
  /** Resume a paused fade over its remaining run time. */
  resume(): void;
  /** Complete the fade now: a quick ramp to the end states, then `onComplete`.
   * Used when the user skips past the fade window — deck A must not play out. */
  finish(): void;
}

/**
 * Start playing deck B and crossfade from deck A over `plan.fadeSeconds`,
 * calling `onComplete` when the fade finishes (the caller then advances the
 * queue; deck B is adopted by the rebuilt player via the hand-off store).
 * `onMidpoint` fires once when half the fade has elapsed; both callbacks run
 * on the fade's own clock, which `pause()`/`resume()` freeze together with the
 * decks and the gain/rate automation.
 *
 * `elapsedSec` (wall-clock) joins the fade mid-flight — deck A was seeked past
 * the mix-out point, so deck B cues that far past its own mix-in, the gains
 * (and ramp rates) start at their mid-fade values, and the clocks run only the
 * remainder. `onMidpoint` fires synchronously if the join is already past it.
 */
export function runTransition(opts: {
  deckA: Deck;
  deckB: Deck;
  plan: TransitionPlan;
  elapsedSec?: number;
  onMidpoint?: () => void;
  onComplete: () => void;
}): TransitionHandle {
  const { deckA, deckB, plan, onMidpoint, onComplete } = opts;
  const ctx = getSharedAudioContext();

  const fade = Math.max(0.05, plan.fadeSeconds);
  // Always leave a sliver of fade to ramp over, even on a seek past the end.
  const elapsed = Math.min(Math.max(opts.elapsedSec ?? 0, 0), fade - 0.05);
  const progress = elapsed / fade;
  const left = fade - elapsed;

  // Cue deck B `elapsed` into its own fade window, at the rate it would have
  // reached by now (for a ramp, its track-time advance is the ramp's average
  // rate over the elapsed stretch), then start it at its mid-fade gain.
  const bRateNow = plan.rateRamp
    ? plan.rateRamp.deckBFrom +
      (plan.rateRamp.deckBTo - plan.rateRamp.deckBFrom) * progress
    : plan.deckBInitialRate;
  const bConsumed = plan.rateRamp
    ? elapsed * ((plan.rateRamp.deckBFrom + bRateNow) / 2)
    : elapsed * plan.deckBInitialRate;
  deckB.setCurrentTime(plan.deckBStartOffsetSec + bConsumed);
  deckB.setRate(bRateNow);
  deckB.play();

  const bGainNow =
    plan.gainCurve === "equalPower"
      ? Math.sin((progress * Math.PI) / 2)
      : progress;
  const aFrom = deckA.gainParam.value * (1 - bGainNow);
  rampGain(deckA.gainParam, ctx, aFrom, 0, left, plan.gainCurve);
  rampGain(deckB.gainParam, ctx, bGainNow, 1, left, plan.gainCurve);

  // Tempo ramp (beatmatch-ramp): automate the buffer-source playbackRate on
  // both decks. Element decks return null and simply hold their entry rate.
  if (plan.rateRamp) {
    const aRate = deckA.rateParam();
    if (aRate) {
      const aRateNow =
        plan.rateRamp.deckAFrom +
        (plan.rateRamp.deckATo - plan.rateRamp.deckAFrom) * progress;
      rampRate(aRate, ctx, aRateNow, plan.rateRamp.deckATo, left);
    }
    const bRate = deckB.rateParam();
    if (bRate) {
      rampRate(bRate, ctx, bRateNow, plan.rateRamp.deckBTo, left);
    }
  }

  // Fade run-time bookkeeping: the completion/midpoint clocks must pause with
  // the decks, so track how much of the fade is left explicitly.
  let remaining = left;
  let midRemaining = Math.max(0, fade / 2 - elapsed);
  let midFired = false;
  let ranAt = ctx.currentTime;
  let paused = false;
  let done = false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let midTimer: ReturnType<typeof setTimeout> | null = null;
  const armTimers = () => {
    if (onMidpoint && !midFired) {
      if (midRemaining <= 0) {
        midFired = true;
        onMidpoint();
      } else {
        midTimer = setTimeout(() => {
          midTimer = null;
          midRemaining = 0;
          midFired = true;
          onMidpoint();
        }, midRemaining * 1000);
      }
    }
    timer = setTimeout(() => {
      timer = null;
      done = true;
      onComplete();
    }, remaining * 1000);
  };
  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (midTimer) clearTimeout(midTimer);
    timer = null;
    midTimer = null;
  };
  armTimers();

  /** Hold a param at its current value, dropping scheduled automation. */
  const holdParam = (param: GainParamLike) => {
    const v = param.value;
    param.cancelScheduledValues(ctx.currentTime);
    param.setValueAtTime(v, ctx.currentTime);
  };

  return {
    pause: () => {
      if (paused || done) return;
      paused = true;
      clearTimers();
      const elapsed = ctx.currentTime - ranAt;
      remaining = Math.max(0.05, remaining - elapsed);
      midRemaining = Math.max(0, midRemaining - elapsed);
      holdParam(deckA.gainParam);
      holdParam(deckB.gainParam);
      if (plan.rateRamp) {
        // Persist the ramped rate through the deck's scalar setter — a local
        // deck rebuilds its buffer node on resume, which would otherwise snap
        // back to the pre-ramp rate.
        const aRate = deckA.rateParam();
        if (aRate) deckA.setRate(aRate.value);
        const bRate = deckB.rateParam();
        if (bRate) deckB.setRate(bRate.value);
      }
      deckA.pause();
      deckB.pause();
    },
    resume: () => {
      if (!paused || done) return;
      paused = false;
      ranAt = ctx.currentTime;
      deckA.play();
      deckB.play();
      rampGain(
        deckA.gainParam,
        ctx,
        deckA.gainParam.value,
        0,
        remaining,
        plan.gainCurve,
      );
      rampGain(
        deckB.gainParam,
        ctx,
        deckB.gainParam.value,
        1,
        remaining,
        plan.gainCurve,
      );
      if (plan.rateRamp) {
        const aRate = deckA.rateParam();
        if (aRate) {
          rampRate(aRate, ctx, aRate.value, plan.rateRamp.deckATo, remaining);
        }
        const bRate = deckB.rateParam();
        if (bRate) {
          rampRate(bRate, ctx, bRate.value, plan.rateRamp.deckBTo, remaining);
        }
      }
      armTimers();
    },
    finish: () => {
      if (done) return;
      done = true;
      clearTimers();
      // Short linear ramp to the end states (no click/pop), then complete.
      const quick = 0.15;
      const now = ctx.currentTime;
      deckA.gainParam.cancelScheduledValues(now);
      deckA.gainParam.setValueAtTime(deckA.gainParam.value, now);
      deckA.gainParam.linearRampToValueAtTime(0, now + quick);
      deckB.gainParam.cancelScheduledValues(now);
      deckB.gainParam.setValueAtTime(deckB.gainParam.value, now);
      deckB.gainParam.linearRampToValueAtTime(1, now + quick);
      if (plan.rateRamp) {
        const bRate = deckB.rateParam();
        if (bRate)
          rampRate(bRate, ctx, bRate.value, plan.rateRamp.deckBTo, quick);
        else deckB.setRate(plan.rateRamp.deckBTo);
      }
      setTimeout(() => onComplete(), quick * 1000);
    },
    cancel: () => {
      done = true;
      clearTimers();
      // Restore deck A to full, silence + stop deck B.
      const now = ctx.currentTime;
      deckA.gainParam.cancelScheduledValues(now);
      deckA.gainParam.setValueAtTime(1, now);
      deckB.gainParam.cancelScheduledValues(now);
      deckB.gainParam.setValueAtTime(0, now);
      deckB.pause();
    },
  };
}

// --- hand-off store ------------------------------------------------------
//
// After a fade completes and the queue advances, the rebuilt WaveformPlayer
// adopts the already-playing deck B instead of decoding/attaching a fresh
// source. Keyed by the incoming track's identity so a stale hand-off (e.g. the
// user skipped manually mid-fade) is ignored rather than mis-adopted.

let handoff: { key: string; deck: Deck } | null = null;

export function stashHandoff(key: string, deck: Deck): void {
  handoff = { key, deck };
}

/** Take the pending hand-off if it matches `key`; otherwise leave it in place. */
export function takeHandoff(key: string): Deck | null {
  if (handoff && handoff.key === key) {
    const deck = handoff.deck;
    handoff = null;
    return deck;
  }
  return null;
}

/** Discard (and tear down) any pending hand-off that wasn't adopted. */
export function clearHandoff(key?: string): void {
  if (!handoff) return;
  if (key && handoff.key !== key) return;
  handoff.deck.destroy();
  handoff = null;
}
