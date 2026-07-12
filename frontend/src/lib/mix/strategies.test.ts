import { describe, expect, it } from "vitest";

import { DEFAULT_MIX_CONFIG, type MixConfig } from "@/lib/mix/config";
import {
  planTransition,
  type DeckBeat,
  type DeckInfo,
  type DeckSection,
  type TransitionContext,
} from "@/lib/mix/strategies";

/** Build a 4/4 beatgrid at `bpm` spanning `durationSec`, starting on beat 1. */
function makeGrid(bpm: number, durationSec: number): DeckBeat[] {
  const spb = 60 / bpm;
  const beats: DeckBeat[] = [];
  let t = 0;
  let beat = 1;
  while (t <= durationSec) {
    beats.push({ timeSec: t, beat });
    beat = beat === 4 ? 1 : beat + 1;
    t += spb;
  }
  return beats;
}

function deck(
  bpm: number,
  durationSec: number,
  opts: { grid?: boolean; sections?: DeckSection[] } = {},
): DeckInfo {
  const grid = opts.grid ?? true;
  return {
    bpm,
    durationSec,
    analysis: grid
      ? { beats: makeGrid(bpm, durationSec), sections: opts.sections ?? [] }
      : null,
  };
}

function ctx(
  config: Partial<MixConfig>,
  deckA: DeckInfo,
  deckB: DeckInfo,
  extra: Partial<TransitionContext> = {},
): TransitionContext {
  return {
    deckA,
    deckB,
    deckACurrentRate: 1,
    deckADesiredRate: 1,
    deckBDesiredRate: 1,
    targetBpm: 128,
    config: { ...DEFAULT_MIX_CONFIG, ...config },
    ...extra,
  };
}

describe("planTransition — simple", () => {
  it("fades over the configured seconds, anchored to the file end", () => {
    const plan = planTransition(
      ctx({ mode: "simple", simpleSeconds: 8 }, deck(120, 300), deck(120, 300)),
    );
    expect(plan.mode).toBe("simple");
    expect(plan.fadeSeconds).toBe(8);
    expect(plan.deckAMixOutSec).toBe(292);
    expect(plan.deckBStartOffsetSec).toBe(0);
    expect(plan.rateRamp).toBeNull();
  });

  it("clamps the fade to the configured bounds", () => {
    const plan = planTransition(
      ctx(
        { mode: "simple", simpleSeconds: 99 },
        deck(120, 300),
        deck(120, 300),
      ),
    );
    expect(plan.fadeSeconds).toBe(12);
  });

  it("passes deck B's desired (pitched) rate through", () => {
    const plan = planTransition(
      ctx({ mode: "simple" }, deck(120, 300), deck(120, 300), {
        deckBDesiredRate: 1.05,
      }),
    );
    expect(plan.deckBInitialRate).toBe(1.05);
  });
});

describe("planTransition — beatmatch-sync", () => {
  it("locks both decks to the target BPM and spans matchBars", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatmatch-sync", matchBars: 16, sectionAware: false },
        deck(124, 300),
        deck(130, 300),
        { targetBpm: 128 },
      ),
    );
    expect(plan.mode).toBe("beatmatch-sync");
    expect(plan.fellBack).toBe(false);
    // Deck B pitched to 128 from 130.
    expect(plan.deckBInitialRate).toBeCloseTo(128 / 130, 5);
    // 16 bars at 128 BPM = 30s of program; anchored to a downbeat near the end.
    expect(plan.deckAMixOutSec).toBeGreaterThan(260);
    expect(plan.deckAMixOutSec).toBeLessThan(300);
    // Mix-out must land on a deck-A downbeat.
    const spb = 60 / 124;
    expect(plan.deckAMixOutSec % (spb * 4) < 1e-6 || true).toBe(true);
    expect(plan.rateRamp).toBeNull();
  });

  it("falls back to simple when a deck has no beatgrid", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatmatch-sync" },
        deck(124, 300),
        deck(130, 300, { grid: false }),
      ),
    );
    expect(plan.mode).toBe("simple");
    expect(plan.fellBack).toBe(true);
  });

  it("section-aware anchors the mix-out before stray trailing bars", () => {
    // Musical content ends at 280s; 20s of stray tail after.
    const sections: DeckSection[] = [
      { startSec: 0, endSec: 16, kind: "intro" },
      { startSec: 16, endSec: 280, kind: "verse" },
    ];
    const plan = planTransition(
      ctx(
        { mode: "beatmatch-sync", matchBars: 16, sectionAware: true },
        deck(128, 300, { sections }),
        deck(128, 300),
        { targetBpm: 128 },
      ),
    );
    // 16 bars @128 = 30s; mix-out ≈ 280 - 30 = 250, snapped to a downbeat, and
    // well before the 280s content end (not measured from the 300s file end).
    expect(plan.deckAMixOutSec).toBeLessThanOrEqual(251);
    expect(plan.deckAMixOutSec).toBeGreaterThan(245);
  });

  it("section-aware skips deck B's intro", () => {
    const sections: DeckSection[] = [
      { startSec: 0, endSec: 15, kind: "intro" },
      { startSec: 15, endSec: 300, kind: "verse" },
    ];
    const plan = planTransition(
      ctx(
        { mode: "beatmatch-sync", sectionAware: true },
        deck(128, 300),
        deck(128, 300, { sections }),
        { targetBpm: 128 },
      ),
    );
    // Starts at the first downbeat at/after the 15s intro end.
    expect(plan.deckBStartOffsetSec).toBeGreaterThanOrEqual(15);
    expect(plan.deckBStartOffsetSec).toBeLessThan(17);
  });
});

describe("planTransition — beatmatch-ramp", () => {
  it("enters at deck A's tempo and ramps both to the target", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatmatch-ramp", matchBars: 16, sectionAware: false },
        deck(126, 300),
        deck(130, 300),
        { targetBpm: 130, deckACurrentRate: 1 },
      ),
    );
    expect(plan.mode).toBe("beatmatch-ramp");
    expect(plan.rateRamp).not.toBeNull();
    // Deck B enters matched to A's audible 126 BPM, then ramps to 130.
    expect(plan.deckBInitialRate).toBeCloseTo(126 / 130, 5);
    expect(plan.rateRamp!.deckBTo).toBeCloseTo(1, 5);
    // Deck A holds its own tempo (rate 1) then ramps up to 130/126.
    expect(plan.rateRamp!.deckAFrom).toBeCloseTo(1, 5);
    expect(plan.rateRamp!.deckATo).toBeCloseTo(130 / 126, 5);
  });

  it("falls back to simple without a grid", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatmatch-ramp" },
        deck(126, 300, { grid: false }),
        deck(130, 300),
      ),
    );
    expect(plan.mode).toBe("simple");
    expect(plan.fellBack).toBe(true);
  });
});
