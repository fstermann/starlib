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
  type LoopRegion,
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
  /** The 3-band EQ gain `AudioParam`s (dB) for the EQ mix modes, or null
   * (element decks bypass the Web Audio graph and can't be EQ'd). */
  bassParam(): AudioParam | null;
  midParam(): AudioParam | null;
  highParam(): AudioParam | null;
  /** Set (or clear) a playback loop — used to loop deck A in the loop-eq mode.
   * No-op for element decks. */
  setLoop(region: LoopRegion | null): void;
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
    bassParam: () => player.getBassParam(),
    midParam: () => player.getMidParam(),
    highParam: () => player.getHighParam(),
    setLoop: (region) => player.setLoop(region),
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
    // Element decks bypass the Web Audio graph — no filters, no native loop.
    bassParam: () => null,
    midParam: () => null,
    highParam: () => null,
    setLoop: () => {},
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

// --- bass EQ swap --------------------------------------------------------

/** Low-shelf gain (dB) that effectively mutes bass (−40 dB ≈ 1% amplitude). */
const BASS_KILL_DB = -40;
/** Ramp time (s) for the bass kill/restore — a hard slam (crisp EQ-kill-switch
 * flip), just long enough to avoid a click. */
const BASS_SWAP_SEC = 0.03;

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

  // Tempo ramp (beatgrid without beat-sync): automate the buffer-source
  // playbackRate on both decks. Element decks return null and simply hold their entry rate.
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

  // Bass EQ handover (beatgrid-eq): the out-going deck owns the bass while the
  // incoming deck's is killed; the out-going bass kills 2 bars before the end,
  // then the incoming bass drops in at the fade end (last 2 bars run bass-free).
  // Element decks return a null bassParam and simply keep full-range audio.
  const eq = plan.eqSwap;
  const aBass = deckA.bassParam();
  const bBass = deckB.bassParam();
  // Time until each event, tracked explicitly so a paused fade re-schedules it.
  let aKillRemaining = eq ? Math.max(0, eq.deckAKillSec - elapsed) : 0;
  let bRestoreRemaining = eq ? Math.max(0, eq.deckBRestoreSec - elapsed) : 0;
  /** Schedule `p`'s step from `pre` to `post` so it *lands* `remaining` s from
   * now (on the downbeat) — the ramp finishes on the target, it doesn't start
   * there, so the incoming bass is full on the beat, not a ramp-width late.
   * `<= 0` → already due (finish/deep join): ramp straight there. */
  const scheduleBassStep = (
    p: AudioParam | null,
    pre: number,
    post: number,
    remaining: number,
  ) => {
    if (!p) return;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    if (remaining <= 0) {
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(post, now + BASS_SWAP_SEC);
      return;
    }
    const rampEnd = now + remaining;
    const rampStart = Math.max(now, rampEnd - BASS_SWAP_SEC);
    p.setValueAtTime(pre, now);
    p.setValueAtTime(pre, rampStart);
    p.linearRampToValueAtTime(post, rampEnd);
  };
  const armBassSwap = () => {
    scheduleBassStep(aBass, 0, BASS_KILL_DB, aKillRemaining); // A: full → killed
    scheduleBassStep(bBass, BASS_KILL_DB, 0, bRestoreRemaining); // B: killed → full
  };
  if (eq) armBassSwap();

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
      if (eq) {
        // Hold the bass filters and freeze the EQ clocks (the scheduled steps
        // run on the audio thread, which keeps ticking while decks are paused).
        aKillRemaining = Math.max(0, aKillRemaining - elapsed);
        bRestoreRemaining = Math.max(0, bRestoreRemaining - elapsed);
        if (aBass) holdParam(aBass);
        if (bBass) holdParam(bBass);
      }
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
      if (eq) armBassSwap();
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
      // Land on the end state (out-going bass killed, incoming bass full) so
      // the adopted deck B keeps full bass.
      if (eq) {
        aKillRemaining = 0;
        bRestoreRemaining = 0;
        armBassSwap();
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
      // Restore deck A's bass — it keeps playing after a rescue.
      if (eq && aBass) {
        aBass.cancelScheduledValues(now);
        aBass.setValueAtTime(0, now);
      }
      deckB.pause();
    },
  };
}

/**
 * The loop-EQ transition (the `loop-eq` mode). Deck A holds full volume and
 * loops its first bars while deck B blends in band-by-band with a 3-band EQ over
 * Phase 1; then deck A fades out underneath over Phase 2. Deck B is adopted at
 * the very end (Phase 2's end). Same {@link TransitionHandle} contract as
 * {@link runTransition}, so orchestration is identical — only the automation
 * differs. `onMidpoint` fires at the transition point (Phase 1's end), where the
 * rail info swaps to deck B.
 *
 * `elapsedSec` (wall-clock) joins the transition mid-flight — a seek landed
 * past the mix-out point, or a post-swipe click re-timed the fade: deck B cues
 * that far past its own mix-in, deck A is placed at the matching phase inside
 * its loop (so the beats stay locked), the band/gain automation starts at its
 * mid-schedule values, and the clocks run only the remainder. `onMidpoint`
 * fires synchronously if the join is already past the transition point.
 * Pause/resume freeze and re-schedule the whole schedule via `elapsedTotal`.
 */
export function runLoopEqTransition(opts: {
  deckA: Deck;
  deckB: Deck;
  plan: TransitionPlan;
  elapsedSec?: number;
  onMidpoint?: () => void;
  onComplete: () => void;
}): TransitionHandle {
  const { deckA, deckB, plan, onMidpoint, onComplete } = opts;
  const le = plan.loopEq!;
  const ctx = getSharedAudioContext();
  const total = Math.max(0.05, plan.fadeSeconds);
  // Always leave a sliver of transition to run, even on a seek past the end.
  const elapsed = Math.min(Math.max(opts.elapsedSec ?? 0, 0), total - 0.05);
  const phase1 = le.phase1Sec;

  const aGain = deckA.gainParam;
  const bGain = deckB.gainParam;
  const aBass = deckA.bassParam();
  const aMid = deckA.midParam();
  const aHigh = deckA.highParam();
  const bBass = deckB.bassParam();
  const bMid = deckB.midParam();
  const bHigh = deckB.highParam();

  // Cue deck B `elapsed` into the transition (constant rate — loop-eq never
  // ramps), loop deck A's first bars, and start B (A already plays). Deck A
  // keeps its current rate; B matches A's audible tempo.
  deckB.setCurrentTime(
    plan.deckBStartOffsetSec + elapsed * plan.deckBInitialRate,
  );
  deckB.setRate(plan.deckBInitialRate);
  deckB.play();
  // Mid-flight join: place deck A at the matching phase inside its loop so its
  // beats stay locked to deck B — a seek may have left it anywhere in the
  // window (even past the loop end, where the native loop never engages). The
  // natural trigger lands at the loop start, where this is a no-op.
  const loopLen = le.loopRegion.end - le.loopRegion.start;
  const rateA = deckA.media.playbackRate || 1;
  const aTarget = le.loopRegion.start + ((elapsed * rateA) % loopLen);
  if (Math.abs(aTarget - deckA.currentTime) > 0.05) {
    deckA.setCurrentTime(aTarget);
  }
  deckA.setLoop(le.loopRegion);

  /** Ramp `p` from `from` (held until `startSec`) to `to` (reached at `endSec`),
   * all in transition-time, offset by `elapsed`. */
  const rampSeg = (
    p: GainParamLike | null,
    from: number,
    to: number,
    startSec: number,
    endSec: number,
    elapsed: number,
  ) => {
    if (!p) return;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    const lStart = startSec - elapsed;
    const lEnd = endSec - elapsed;
    if (lEnd <= 0) {
      p.setValueAtTime(to, now);
      return;
    }
    if (lStart <= 0) {
      const frac = Math.min(
        1,
        Math.max(0, (elapsed - startSec) / (endSec - startSec)),
      );
      p.setValueAtTime(from + (to - from) * frac, now);
      p.linearRampToValueAtTime(to, now + lEnd);
      return;
    }
    p.setValueAtTime(from, now);
    p.setValueAtTime(from, now + lStart);
    p.linearRampToValueAtTime(to, now + lEnd);
  };

  /** Hard swap `p` from `pre` to `post`, the ramp *finishing* at `atSec`
   * (transition-time), offset by `elapsed`. Mirrors the bass swap. */
  const stepSeg = (
    p: GainParamLike | null,
    pre: number,
    post: number,
    atSec: number,
    elapsed: number,
  ) => {
    if (!p) return;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    const lAt = atSec - elapsed;
    if (lAt <= 0) {
      p.setValueAtTime(post, now);
      return;
    }
    const rampEnd = now + lAt;
    const rampStart = Math.max(now, rampEnd - BASS_SWAP_SEC);
    p.setValueAtTime(pre, now);
    p.setValueAtTime(pre, rampStart);
    p.linearRampToValueAtTime(post, rampEnd);
  };

  const armParams = (elapsed: number) => {
    // Volumes: A full through Phase 1 then fades out over Phase 2; B fades in.
    rampSeg(aGain, 1, 0, phase1, total, elapsed);
    rampSeg(bGain, 0, 1, 0, phase1, elapsed);
    // A EQ: highs then mids dip to the cut; bass hard-kills near the point.
    rampSeg(
      aHigh,
      0,
      le.cutDb,
      le.highsRamp.startSec,
      le.highsRamp.endSec,
      elapsed,
    );
    rampSeg(
      aMid,
      0,
      le.cutDb,
      le.midsRamp.startSec,
      le.midsRamp.endSec,
      elapsed,
    );
    stepSeg(aBass, 0, le.killDb, le.bassKillSec, elapsed);
    // B EQ: highs then mids open to neutral; bass hard-slams in near the point.
    rampSeg(
      bHigh,
      le.cutDb,
      0,
      le.highsRamp.startSec,
      le.highsRamp.endSec,
      elapsed,
    );
    rampSeg(
      bMid,
      le.cutDb,
      0,
      le.midsRamp.startSec,
      le.midsRamp.endSec,
      elapsed,
    );
    stepSeg(bBass, le.killDb, 0, le.bassSlamSec, elapsed);
  };

  const hold = (p: GainParamLike | null) => {
    if (!p) return;
    const v = p.value;
    p.cancelScheduledValues(ctx.currentTime);
    p.setValueAtTime(v, ctx.currentTime);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let midTimer: ReturnType<typeof setTimeout> | null = null;
  let midFired = false;
  let elapsedTotal = elapsed;
  let ranAt = ctx.currentTime;
  let paused = false;
  let done = false;

  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (midTimer) clearTimeout(midTimer);
    timer = null;
    midTimer = null;
  };
  const armTimers = (elapsed: number) => {
    if (onMidpoint && !midFired) {
      const midRemain = phase1 - elapsed;
      if (midRemain <= 0) {
        midFired = true;
        onMidpoint();
      } else {
        midTimer = setTimeout(() => {
          midTimer = null;
          midFired = true;
          onMidpoint();
        }, midRemain * 1000);
      }
    }
    timer = setTimeout(
      () => {
        timer = null;
        done = true;
        onComplete();
      },
      Math.max(0, total - elapsed) * 1000,
    );
  };

  armParams(elapsed);
  armTimers(elapsed);

  const allParams = [aGain, bGain, aBass, aMid, aHigh, bBass, bMid, bHigh];

  return {
    pause: () => {
      if (paused || done) return;
      paused = true;
      clearTimers();
      elapsedTotal += ctx.currentTime - ranAt;
      allParams.forEach(hold);
      deckA.pause();
      deckB.pause();
    },
    resume: () => {
      if (!paused || done) return;
      paused = false;
      ranAt = ctx.currentTime;
      deckA.play();
      deckB.play();
      armParams(elapsedTotal);
      armTimers(elapsedTotal);
    },
    finish: () => {
      if (done) return;
      done = true;
      clearTimers();
      const now = ctx.currentTime;
      const quick = 0.15;
      const quickRamp = (p: GainParamLike | null, to: number) => {
        if (!p) return;
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(to, now + quick);
      };
      // Land the end state: A silent, B full and neutral.
      quickRamp(aGain, 0);
      quickRamp(bGain, 1);
      quickRamp(bBass, 0);
      quickRamp(bMid, 0);
      quickRamp(bHigh, 0);
      if (onMidpoint && !midFired) {
        midFired = true;
        onMidpoint();
      }
      setTimeout(() => onComplete(), quick * 1000);
    },
    cancel: () => {
      done = true;
      clearTimers();
      const now = ctx.currentTime;
      // Restore deck A (keeps playing after a rescue): full gain, flat EQ, no loop.
      aGain.cancelScheduledValues(now);
      aGain.setValueAtTime(1, now);
      [aBass, aMid, aHigh].forEach((p) => {
        if (!p) return;
        p.cancelScheduledValues(now);
        p.setValueAtTime(0, now);
      });
      deckA.setLoop(null);
      // Silence + stop deck B (discarded).
      bGain.cancelScheduledValues(now);
      bGain.setValueAtTime(0, now);
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
