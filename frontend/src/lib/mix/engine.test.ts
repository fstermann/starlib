import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  equalPowerCurve,
  htmlDeck,
  rampedElapsedAudioTime,
  runLoopEqTransition,
  runTransition,
  type Deck,
} from "@/lib/mix/engine";
import type { GainParamLike, HtmlGainRoute } from "@/lib/mix/html-deck";
import type { TransitionPlan } from "@/lib/mix/strategies";

// The engine reaches the shared AudioContext only for its clock; give it a
// fake whose time the tests advance by hand.
const shared = vi.hoisted(() => ({ ctx: { currentTime: 0 } }));
vi.mock("hls.js", () => ({ default: { isSupported: () => false } }));
vi.mock("@/lib/looping-web-audio-player", () => ({
  getSharedAudioContext: () => shared.ctx,
  LoopingWebAudioPlayer: class {},
}));

function fakeParam(initial: number) {
  const p = {
    value: initial,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((v: number) => {
      p.value = v;
    }),
    setValueCurveAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  return p;
}

/** A minimal local-style deck with scalar position/rate bookkeeping. */
function fakeDeck() {
  const gain = fakeParam(1);
  const rate = fakeParam(1);
  const state = { pos: 0, rate: 1 };
  const deck: Deck = {
    kind: "local",
    media: {} as Deck["media"],
    hls: null,
    duration: 600,
    get currentTime() {
      return state.pos;
    },
    play: vi.fn(),
    pause: vi.fn(),
    setCurrentTime: (sec: number) => {
      state.pos = sec;
    },
    setRate: (r: number) => {
      state.rate = r;
    },
    gainParam: gain as GainParamLike,
    rateParam: () => rate as unknown as AudioParam,
    bassParam: () => null,
    midParam: () => null,
    highParam: () => null,
    setLoop: vi.fn(),
    destroy: vi.fn(),
  };
  return { deck, gain, rate, state };
}

function basePlan(overrides: Partial<TransitionPlan>): TransitionPlan {
  return {
    mode: "beatgrid",
    fellBack: false,
    fadeSeconds: 30,
    deckAMixOutSec: 100,
    deckBStartOffsetSec: 0,
    deckBInitialRate: 1,
    rateRamp: null,
    gainCurve: "equalPower",
    eqSwap: null,
    loopEq: null,
    ...overrides,
  };
}

describe("equalPowerCurve", () => {
  it("keeps summed power at 1 for a 0→1 / 1→0 pair", () => {
    const up = equalPowerCurve(0, 1);
    const down = equalPowerCurve(1, 0);
    for (let i = 0; i < up.length; i++) {
      expect(up[i] ** 2 + down[i] ** 2).toBeCloseTo(1, 6);
    }
  });

  it("keeps summed power at 1 for a mid-fade complement pair", () => {
    // A resumed/joined fade: B continues from 0.6 up, A from its equal-power
    // complement (√(1−0.36) = 0.8) down.
    const up = equalPowerCurve(0.6, 1);
    const down = equalPowerCurve(0.8, 0);
    for (let i = 0; i < up.length; i++) {
      expect(up[i] ** 2 + down[i] ** 2).toBeCloseTo(1, 6);
    }
  });
});

describe("rampedElapsedAudioTime", () => {
  it("integrates a linear ramp up to the elapsed point", () => {
    // 1 → 1.12 over 30s, paused at 15s: average rate 1.03 → 15.45s of audio.
    expect(
      rampedElapsedAudioTime(
        { fromRate: 1, toRate: 1.12, durationSec: 30 },
        15,
      ),
    ).toBeCloseTo(15.45, 9);
  });

  it("holds the target rate after the ramp ends", () => {
    expect(
      rampedElapsedAudioTime(
        { fromRate: 1, toRate: 1.12, durationSec: 30 },
        40,
      ),
    ).toBeCloseTo((30 * (1 + 1.12)) / 2 + 10 * 1.12, 9);
  });

  it("holds the entry rate before a delayed ramp starts", () => {
    const seg = { fromRate: 1.11, toRate: 1, startSec: 10, durationSec: 10 };
    expect(rampedElapsedAudioTime(seg, 8)).toBeCloseTo(8 * 1.11, 9);
    expect(rampedElapsedAudioTime(seg, 15)).toBeCloseTo(
      10 * 1.11 + (5 * (1.11 + 1.055)) / 2,
      9,
    );
  });

  it("is the plain product for a constant rate", () => {
    expect(
      rampedElapsedAudioTime(
        { fromRate: 1.2, toRate: 1.2, durationSec: 30 },
        10,
      ),
    ).toBeCloseTo(12, 9);
  });
});

describe("htmlDeck", () => {
  function makeAudio() {
    return {
      pause: vi.fn(),
      remove: vi.fn(),
      src: "blob:x",
      currentTime: 0,
      duration: 100,
    } as unknown as HTMLAudioElement;
  }
  const route = (): HtmlGainRoute => ({
    gainParam: fakeParam(1) as GainParamLike,
    dispose: vi.fn(),
  });

  it("exposes the hls instance and destroys it on destroy()", () => {
    const hls = { destroy: vi.fn() };
    const audio = makeAudio();
    const deck = htmlDeck(audio, route(), hls as never);
    expect(deck.hls).toBe(hls);
    deck.destroy();
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(audio.remove).toHaveBeenCalledTimes(1);
  });

  it("destroys cleanly without an hls instance", () => {
    const audio = makeAudio();
    const deck = htmlDeck(audio, route());
    expect(deck.hls).toBeNull();
    expect(() => deck.destroy()).not.toThrow();
    expect(audio.remove).toHaveBeenCalledTimes(1);
  });
});

describe("runTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shared.ctx.currentTime = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins mid-fade with the equal-power complement on deck A", () => {
    const a = fakeDeck();
    const b = fakeDeck();
    runTransition({
      deckA: a.deck,
      deckB: b.deck,
      plan: basePlan({}),
      elapsedSec: 15, // half of the 30s fade → B at sin(π/4)
      onComplete: () => {},
    });
    // Deck A's fade starts from cos(π/4) = √(1−sin²), not 1−sin.
    expect(a.gain.setValueAtTime).toHaveBeenCalledTimes(1);
    expect(a.gain.setValueAtTime.mock.calls[0][0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("corrects both decks' positions when pausing mid tempo-ramp", () => {
    const a = fakeDeck();
    const b = fakeDeck();
    a.deck.setCurrentTime(100);
    const plan = basePlan({
      deckBInitialRate: 1.12,
      rateRamp: { deckAFrom: 1, deckATo: 1.12, deckBFrom: 1.12, deckBTo: 1 },
    });
    const handle = runTransition({
      deckA: a.deck,
      deckB: b.deck,
      plan,
      onComplete: () => {},
    });
    // 15s of wall clock into the 30s ramp; the rate params reached mid-ramp.
    shared.ctx.currentTime = 15;
    a.rate.value = 1.06;
    b.rate.value = 1.06;
    handle.pause();
    // The scalar bookkeeping would have folded 15s at the stale entry rates;
    // the true positions integrate the ramp: avg(1, 1.06) and avg(1.12, 1.06).
    expect(a.deck.currentTime).toBeCloseTo(100 + (15 * (1 + 1.06)) / 2, 6);
    expect(b.deck.currentTime).toBeCloseTo((15 * (1.12 + 1.06)) / 2, 6);
    // The ramped rate was persisted through the scalar setter for resume.
    expect(a.state.rate).toBeCloseTo(1.06, 6);
    expect(b.state.rate).toBeCloseTo(1.06, 6);

    // Resume re-arms the remaining ramp; a second pause keeps integrating
    // from the corrected position.
    shared.ctx.currentTime = 20;
    handle.resume();
    shared.ctx.currentTime = 25;
    a.rate.value = 1.08; // 1.06 → 1.12 over the remaining 15s, 5s in
    b.rate.value = 1.04; // 1.06 → 1 over the remaining 15s, 5s in
    handle.pause();
    expect(a.deck.currentTime).toBeCloseTo(
      100 + (15 * (1 + 1.06)) / 2 + (5 * (1.06 + 1.08)) / 2,
      6,
    );
    expect(b.deck.currentTime).toBeCloseTo(
      (15 * (1.12 + 1.06)) / 2 + (5 * (1.06 + 1.04)) / 2,
      6,
    );
  });
});

describe("runLoopEqTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shared.ctx.currentTime = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const loopEqPlan = (deckBEndRate: number | null): TransitionPlan =>
    basePlan({
      mode: "loop-eq",
      fadeSeconds: 20,
      deckBInitialRate: 1.11,
      loopEq: {
        phase1Sec: 10,
        phase2Sec: 10,
        loopRegion: { start: 100, end: 107.5 },
        highsRamp: { startSec: 0, endSec: 3 },
        midsRamp: { startSec: 3, endSec: 6 },
        bassKillSec: 6,
        bassSlamSec: 9.5,
        cutDb: -9,
        killDb: -40,
        deckBEndRate,
      },
    });

  it("ramps deck B's rate to the plan's end rate over Phase 2", () => {
    const a = fakeDeck();
    const b = fakeDeck();
    runLoopEqTransition({
      deckA: a.deck,
      deckB: b.deck,
      plan: loopEqPlan(1),
      onComplete: () => {},
    });
    // Held at the entry rate until Phase 1 ends, then ramped to 1 by the end.
    expect(b.rate.setValueAtTime).toHaveBeenCalledWith(1.11, 0);
    expect(b.rate.setValueAtTime).toHaveBeenCalledWith(1.11, 10);
    expect(b.rate.linearRampToValueAtTime).toHaveBeenCalledWith(1, 20);
  });

  it("holds a constant rate when the plan has no end ramp", () => {
    const a = fakeDeck();
    const b = fakeDeck();
    runLoopEqTransition({
      deckA: a.deck,
      deckB: b.deck,
      plan: loopEqPlan(null),
      onComplete: () => {},
    });
    expect(b.state.rate).toBeCloseTo(1.11, 6);
    expect(b.rate.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it("corrects deck B's position when pausing mid rate-ramp", () => {
    const a = fakeDeck();
    const b = fakeDeck();
    const handle = runLoopEqTransition({
      deckA: a.deck,
      deckB: b.deck,
      plan: loopEqPlan(1),
      onComplete: () => {},
    });
    // 5s into Phase 2: the rate param reached 1.11 → 1 halfway, 1.055.
    shared.ctx.currentTime = 15;
    b.rate.value = 1.055;
    handle.pause();
    expect(b.deck.currentTime).toBeCloseTo(
      10 * 1.11 + (5 * (1.11 + 1.055)) / 2,
      6,
    );
    expect(b.state.rate).toBeCloseTo(1.055, 6);
  });
});
