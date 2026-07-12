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

import { createHtmlDeck, type HtmlGainRoute } from "./html-deck";
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
  /** The gain `AudioParam` to crossfade. */
  readonly gainParam: AudioParam;
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
  param: AudioParam,
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
}

/**
 * Start playing deck B and crossfade from deck A over `plan.fadeSeconds`,
 * calling `onComplete` when the fade finishes (the caller then advances the
 * queue; deck B is adopted by the rebuilt player via the hand-off store).
 */
export function runTransition(opts: {
  deckA: Deck;
  deckB: Deck;
  plan: TransitionPlan;
  onComplete: () => void;
}): TransitionHandle {
  const { deckA, deckB, plan, onComplete } = opts;
  const ctx = getSharedAudioContext();

  // Cue deck B to its mix-in point, at its entry rate, then start it silent.
  deckB.setCurrentTime(plan.deckBStartOffsetSec);
  deckB.setRate(plan.deckBInitialRate);
  deckB.play();

  const fade = Math.max(0.05, plan.fadeSeconds);
  const aFrom = deckA.gainParam.value;
  rampGain(deckA.gainParam, ctx, aFrom, 0, fade, plan.gainCurve);
  rampGain(deckB.gainParam, ctx, 0, 1, fade, plan.gainCurve);

  // Tempo ramp (beatmatch-ramp): automate the buffer-source playbackRate on
  // both decks. Element decks return null and simply hold their entry rate.
  if (plan.rateRamp) {
    const aRate = deckA.rateParam();
    if (aRate) {
      rampRate(
        aRate,
        ctx,
        plan.rateRamp.deckAFrom,
        plan.rateRamp.deckATo,
        fade,
      );
    }
    const bRate = deckB.rateParam();
    if (bRate) {
      rampRate(
        bRate,
        ctx,
        plan.rateRamp.deckBFrom,
        plan.rateRamp.deckBTo,
        fade,
      );
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    onComplete();
  }, fade * 1000);

  return {
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
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
