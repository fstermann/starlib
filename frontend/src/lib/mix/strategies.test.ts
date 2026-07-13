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
    beatSync: true,
    config: { ...DEFAULT_MIX_CONFIG, ...config },
    ...extra,
  };
}

describe("planTransition — crossfade", () => {
  it("fades over the configured seconds, anchored to the file end", () => {
    const plan = planTransition(
      ctx(
        { mode: "crossfade", crossfadeSeconds: 8 },
        deck(120, 300),
        deck(120, 300),
      ),
    );
    expect(plan.mode).toBe("crossfade");
    expect(plan.fadeSeconds).toBe(8);
    expect(plan.deckAMixOutSec).toBe(292);
    expect(plan.deckBStartOffsetSec).toBe(0);
    expect(plan.rateRamp).toBeNull();
  });

  it("clamps the fade to the configured bounds", () => {
    const plan = planTransition(
      ctx(
        { mode: "crossfade", crossfadeSeconds: 99 },
        deck(120, 300),
        deck(120, 300),
      ),
    );
    expect(plan.fadeSeconds).toBe(12);
  });

  it("passes deck B's desired (pitched) rate through", () => {
    const plan = planTransition(
      ctx({ mode: "crossfade" }, deck(120, 300), deck(120, 300), {
        deckBDesiredRate: 1.05,
      }),
    );
    expect(plan.deckBInitialRate).toBe(1.05);
  });
});

describe("planTransition — beatgrid (beat-sync on)", () => {
  it("locks both decks to the target BPM and spans matchBars", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatgrid", matchBars: 16, sectionAware: false },
        deck(124, 300),
        deck(130, 300),
        { targetBpm: 128 },
      ),
    );
    expect(plan.mode).toBe("beatgrid");
    expect(plan.fellBack).toBe(false);
    // Deck B pitched to 128 from 130.
    expect(plan.deckBInitialRate).toBeCloseTo(128 / 130, 5);
    // 16 bars at 128 BPM = 30s of program; anchored to a downbeat near the end.
    expect(plan.deckAMixOutSec).toBeGreaterThan(260);
    expect(plan.deckAMixOutSec).toBeLessThan(300);
    // Mix-out is an actual deck-A grid downbeat.
    const downbeats = makeGrid(124, 300)
      .filter((b) => b.beat === 1)
      .map((b) => b.timeSec);
    expect(downbeats).toContain(plan.deckAMixOutSec);
    // The overlap is 16 bars of deck-A grid played at the target tempo → the
    // wall-clock fade is 16 bars at 128 BPM = 30s.
    expect(plan.fadeSeconds).toBeCloseTo(30, 5);
    expect(plan.rateRamp).toBeNull();
  });

  it("falls back to crossfade when a deck has no beatgrid", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatgrid" },
        deck(124, 300),
        deck(130, 300, { grid: false }),
      ),
    );
    expect(plan.mode).toBe("crossfade");
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
        { mode: "beatgrid", matchBars: 16, sectionAware: true },
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

  it("ends the fade exactly on the content-end downbeat of a ms-rounded grid", () => {
    // Real rekordbox grids carry per-tick ms rounding, so "content end minus a
    // computed fade length" almost never lands exactly on a tick — the old
    // subtract-then-snap anchoring then snapped a whole bar early. Walking the
    // grid must end the fade on the section-end downbeat itself.
    const bpm = 126;
    const spb = 60 / bpm; // 0.47619… — every tick rounds to whole ms
    const beats: DeckBeat[] = [];
    for (let i = 0; i * spb <= 300; i++) {
      beats.push({
        timeSec: Math.round(i * spb * 1000) / 1000,
        beat: (i % 4) + 1,
      });
    }
    const downbeats = beats.filter((b) => b.beat === 1);
    const endDownbeat = downbeats[downbeats.length - 4]; // content ends here
    const deckA: DeckInfo = {
      bpm,
      durationSec: 300,
      analysis: {
        beats,
        sections: [{ startSec: 0, endSec: endDownbeat.timeSec, kind: "verse" }],
      },
    };
    const plan = planTransition(
      ctx(
        { mode: "beatgrid", matchBars: 16, sectionAware: true },
        deckA,
        deck(128, 300),
        { targetBpm: 126 },
      ),
    );
    // Mix-out is exactly 16 downbeats before the content end…
    expect(plan.deckAMixOutSec).toBe(
      downbeats[downbeats.length - 4 - 16].timeSec,
    );
    // …and the fade (at rate 1 here) ends exactly on the content-end downbeat.
    expect(plan.deckAMixOutSec + plan.fadeSeconds).toBeCloseTo(
      endDownbeat.timeSec,
      6,
    );
  });

  it("section-aware skips deck B's intro", () => {
    const sections: DeckSection[] = [
      { startSec: 0, endSec: 15, kind: "intro" },
      { startSec: 15, endSec: 300, kind: "verse" },
    ];
    const plan = planTransition(
      ctx(
        { mode: "beatgrid", sectionAware: true },
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

describe("planTransition — beatgrid (beat-sync off)", () => {
  it("ignores the pitcher target and ramps both to deck B's own tempo", () => {
    // targetBpm (140) differs from both decks: beat-sync off must ignore it —
    // the incoming track wins, deck B ends at its natural rate, pitcher stays off.
    const plan = planTransition(
      ctx(
        { mode: "beatgrid", matchBars: 16, sectionAware: false },
        deck(126, 300),
        deck(130, 300),
        { targetBpm: 140, deckACurrentRate: 1, beatSync: false },
      ),
    );
    expect(plan.mode).toBe("beatgrid");
    expect(plan.rateRamp).not.toBeNull();
    // Deck B enters matched to A's audible 126 BPM, then ramps to its natural rate.
    expect(plan.deckBInitialRate).toBeCloseTo(126 / 130, 5);
    expect(plan.rateRamp!.deckBTo).toBeCloseTo(1, 5);
    // Deck A holds its own tempo (rate 1) then bends up to deck B's 130 BPM.
    expect(plan.rateRamp!.deckAFrom).toBeCloseTo(1, 5);
    expect(plan.rateRamp!.deckATo).toBeCloseTo(130 / 126, 5);
  });

  it("falls back to crossfade without a grid", () => {
    const plan = planTransition(
      ctx(
        { mode: "beatgrid" },
        deck(126, 300, { grid: false }),
        deck(130, 300),
        { beatSync: false },
      ),
    );
    expect(plan.mode).toBe("crossfade");
    expect(plan.fellBack).toBe(true);
  });
});
