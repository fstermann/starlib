import { describe, expect, it } from "vitest";

import { analyserReducer, INITIAL_STATE } from "./_state";

const scan = (scan_s: number, tier: "sweep" | "refine" = "sweep") =>
  ({
    type: "sse",
    event: {
      type: "shazam.scan",
      job_id: "j",
      scan_s,
      title: "T",
      artist: "A",
      shazam_id: "shz",
      confidence: 0.9,
      pitch_offset: 0,
      tier,
    },
  }) as const;

describe("shazam scan progress", () => {
  it("cached rows replayed before scan_started are not counted", () => {
    // Replay order after the backend fix: historical scan rows first,
    // then the run marker with completed_points, then live scans.
    let s = INITIAL_STATE;
    s = analyserReducer(s, scan(0));
    s = analyserReducer(s, scan(60));
    s = analyserReducer(s, {
      type: "sse",
      event: {
        type: "shazam.scan_started",
        job_id: "j",
        tier: "sweep",
        region: null,
        total_points: 10,
        completed_points: 2,
      },
    });
    s = analyserReducer(s, scan(120));

    const run = s.activeShazamScan!;
    expect(run.completedPoints).toBe(2);
    expect(run.arrivedScanS).toEqual([120]);
    // What the header displays: completed + arrived = 3 of 10.
    expect(run.completedPoints + run.arrivedScanS.length).toBe(3);
    expect(run.totalPoints).toBe(10);
  });

  it("live scans from a different tier are not counted", () => {
    let s = INITIAL_STATE;
    s = analyserReducer(s, {
      type: "sse",
      event: {
        type: "shazam.scan_started",
        job_id: "j",
        tier: "refine",
        region: null,
        total_points: 5,
      },
    });
    s = analyserReducer(s, scan(0, "sweep"));
    expect(s.activeShazamScan!.arrivedScanS).toEqual([]);
  });
});
