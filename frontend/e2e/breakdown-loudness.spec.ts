import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Set Breakdown over a local recording: starting from a file path, the
 * loudness panel (EBU R128 readings, gain to a target, per-track levelling,
 * transition jumps, bass balance), the timeline's LUFS chart, per-track
 * loudness in the tracklist, importing a CUE sheet, and comparing the set
 * with another one. The backend is mocked.
 */

const JOB = "local-set-job";
const SET_PATH = "/Users/dj/Music/Recordings/friday.wav";

const TRACKS = [
  {
    id: 1,
    start_s: 0,
    end_s: 300,
    title: "First",
    artist: "A",
    shazam_id: null,
    confidence: 1,
    source: "manual",
    confirmed: true,
    user_edited: true,
  },
  {
    id: 2,
    start_s: 300,
    end_s: 600,
    title: "Second",
    artist: "B",
    shazam_id: null,
    confidence: 1,
    source: "manual",
    confirmed: true,
    user_edited: true,
  },
];

const SPECTRUM_CENTRES = Array.from(
  { length: 60 },
  (_, i) => 20 * 2 ** ((i + 0.5) / 6),
);

function bands(levels: number[]) {
  const spans: Array<[string, number, number]> = [
    ["Sub", 20, 60],
    ["Bass", 60, 150],
    ["Low mid", 150, 500],
    ["Mid", 500, 2000],
    ["High mid", 2000, 6000],
    ["Air", 6000, 20000],
  ];
  return spans.map(([name, low_hz, high_hz], i) => ({
    name,
    low_hz,
    high_hz,
    level_db: levels[i],
  }));
}

const REPORT = {
  integrated_lufs: -10.4,
  loudness_range_lu: 5.2,
  true_peak_dbtp: -0.6,
  short_term_max_lufs: -7.1,
  short_term_min_lufs: -14.8,
  momentary_max_lufs: -5.9,
  curve: {
    step_s: 1,
    floor_lufs: -70,
    short_term_lufs: Array.from({ length: 600 }, (_, i) =>
      i < 300 ? -8 : -12,
    ),
    // Over the -1 dBTP ceiling only at 1:40-1:43; the gain to -9 LUFS pushes the whole first track over.
    true_peak_dbtp: Array.from({ length: 600 }, (_, i) =>
      i >= 100 && i < 103 ? -0.6 : i < 300 ? -2 : -6,
    ),
  },
  reference_lufs: -10,
  tolerance_lu: 1,
  low_end_reference_lu: -5,
  low_end_tolerance_lu: 2,
  transitions: [
    {
      at_s: 300,
      from_label: "A - First",
      to_label: "B - Second",
      before_lufs: -8.2,
      after_lufs: -11.9,
      jump_lu: -3.7,
    },
  ],
  transition_window_s: 30,
  transition_jump_lu: 2,
  segments: [
    {
      start_s: 0,
      end_s: 300,
      label: "A - First",
      integrated_lufs: -8,
      true_peak_dbtp: -0.6,
      suggested_gain_db: -2,
      low_end_lu: -2,
    },
    {
      start_s: 300,
      end_s: 600,
      label: "B - Second",
      integrated_lufs: -12,
      true_peak_dbtp: -3.2,
      suggested_gain_db: 2,
      low_end_lu: -5.5,
    },
  ],
  spectrum: {
    centres_hz: SPECTRUM_CENTRES,
    level_db: SPECTRUM_CENTRES.map((_, i) => -8 - i * 0.3),
  },
  bands: bands([-6, -4, -8, -10, -13, -14]),
};

const REFERENCE_JOB = "pro-mix-job";

/** A louder, denser master with less high mid. */
const REFERENCE_REPORT = {
  ...REPORT,
  integrated_lufs: -7.3,
  loudness_range_lu: 4.6,
  true_peak_dbtp: -1,
  short_term_max_lufs: -4.9,
  spectrum: {
    centres_hz: SPECTRUM_CENTRES,
    level_db: SPECTRUM_CENTRES.map((_, i) => -7 - i * 0.35),
  },
  bands: bands([-5.8, -4.1, -7.3, -10.5, -14.6, -14.2]),
};

function jobSummary(id: string, title: string) {
  return {
    id,
    soundcloud_id: null,
    local_path: `/Users/dj/Music/${title}.wav`,
    title,
    artist: null,
    duration_s: 600,
    status: "complete",
    created_at: 0,
    track_count: 0,
    confirmed_count: 0,
  };
}

function snapshot(timeline: unknown[] = []) {
  return {
    id: JOB,
    soundcloud_id: null,
    local_path: SET_PATH,
    source_url: null,
    title: "friday",
    artist: null,
    duration_s: 600,
    status: "complete",
    options: {
      pitch_strategy: "none",
      window_s: 30,
      hop_s: 25,
      min_section_gap_s: 90,
      sections_enabled: true,
      scan_cadence_s: 45,
      scan_window_s: 12,
    },
    error: null,
    created_at: 0,
    updated_at: 0,
    windows: [],
    sections: [],
    scans: [],
    timeline,
  };
}

async function mockJob(
  page: Page,
  opts: {
    timeline?: unknown[];
    measured?: boolean;
    progress?: number;
    measureDone?: Promise<void>;
    jobs?: unknown[];
  } = {},
) {
  let timeline = opts.timeline ?? [];
  let measured = opts.measured ?? false;
  const calls = { measure: 0, cueUploads: [] as string[] };

  await page.route(/\/api\/breakdown\/sets(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: opts.jobs ?? [] }),
    }),
  );
  await page.route(new RegExp(`/api/breakdown/sets/${JOB}$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot(timeline)),
    }),
  );
  await page.route(new RegExp(`/api/breakdown/sets/${JOB}/events$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    }),
  );
  await page.route(new RegExp(`/api/breakdown/sets/${JOB}/audio$`), (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: "" }),
  );
  await page.route(
    new RegExp(`/api/breakdown/sets/${JOB}/loudness/progress$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ progress: opts.progress ?? null }),
      }),
  );
  await page.route(
    new RegExp(`/api/breakdown/sets/${JOB}/loudness$`),
    async (route) => {
      if (route.request().method() === "POST") {
        calls.measure += 1;
        await opts.measureDone;
        measured = true;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ report: measured ? REPORT : null }),
      });
    },
  );
  await page.route(
    new RegExp(`/api/breakdown/sets/${JOB}/tracks/import-cue$`),
    (route) => {
      calls.cueUploads.push(route.request().postData() ?? "");
      timeline = TRACKS;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: JOB,
          imported: 2,
          skipped: 1,
          linked: 2,
        }),
      });
    },
  );
  return calls;
}

test("starts a Set Breakdown from a local file path", async ({ page }) => {
  await mockJob(page);
  let startBody: Record<string, unknown> | null = null;
  await page.route(/\/api\/breakdown\/sets(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      startBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ job_id: JOB }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [] }),
    });
  });

  await page.goto("/breakdown?view=set");
  const start = page.getByTestId("breakdown-local-start-button");
  await expect(start).toBeDisabled();
  await page.getByTestId("breakdown-local-path-input").fill(SET_PATH);
  await start.click();

  await expect(page).toHaveURL(new RegExp(`job=${JOB}`));
  expect(startBody).toMatchObject({ local_path: SET_PATH });
  await expect(page.getByTestId("loudness-panel")).toBeVisible();
});

test("measures loudness, gives the gain to a target and which tracks to level", async ({
  page,
}) => {
  const calls = await mockJob(page, { timeline: TRACKS });
  await page.goto(`/breakdown?job=${JOB}`);

  const panel = page.getByTestId("loudness-panel");
  await expect(panel.getByTestId("loudness-summary")).toHaveCount(0);
  await panel.getByTestId("loudness-measure").click();

  await expect(panel.getByTestId("loudness-integrated")).toHaveText(
    "-10.4 LUFS",
  );
  await expect(panel.getByTestId("loudness-short-term-max")).toHaveText(
    "-7.1 LUFS",
  );
  await expect(panel.getByTestId("loudness-short-term-min")).toHaveText(
    "-14.8 LUFS",
  );
  await expect(panel.getByTestId("loudness-true-peak")).toHaveText("-0.6 dBTP");
  await expect(panel.getByTestId("loudness-peak-overs")).toContainText(
    "00:03 above -1 dBTP",
  );
  expect(calls.measure).toBe(1);

  await panel.getByTestId("loudness-target").fill("-9");
  await expect(panel.getByTestId("loudness-gain")).toContainText("+1.4 dB");
  await expect(panel.getByTestId("loudness-peak-after-gain")).toHaveText(
    "0.8 dBTP",
  );
  await expect(panel.getByTestId("loudness-peak-overs")).toContainText(
    "05:00 above -1 dBTP after the gain",
  );

  const suggestions = panel.getByTestId("loudness-suggestion");
  await expect(suggestions).toHaveCount(2);
  await expect(suggestions.first()).toContainText("A - First");
  await expect(
    suggestions.first().getByTestId("loudness-suggestion-gain"),
  ).toHaveText("-2.0 dB");
  await expect(
    suggestions.nth(1).getByTestId("loudness-suggestion-gain"),
  ).toHaveText("+2.0 dB");

  // The target is remembered for the next set.
  await page.reload();
  await expect(page.getByTestId("loudness-target")).toHaveValue("-9");
});

test("per-track loudness follows the min-matches filter", async ({ page }) => {
  await mockJob(page, { timeline: TRACKS, measured: true });
  const filtered: string[] = [];
  await page.route(
    new RegExp(`/api/breakdown/sets/${JOB}/loudness\\?min_matches=\\d+$`),
    (route) => {
      filtered.push(new URL(route.request().url()).search);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ report: REPORT }),
      });
    },
  );
  await page.goto(`/breakdown?job=${JOB}`);
  await expect(page.getByTestId("loudness-summary")).toBeVisible();

  const thumb = page.getByTestId("min-matches-slider").getByRole("slider");
  await thumb.focus();
  await thumb.press("ArrowRight");

  await expect.poll(() => filtered).toContain("?min_matches=2");
});

test("imports a CUE sheet as the tracklist", async ({ page }) => {
  const calls = await mockJob(page);
  await page.goto(`/breakdown?job=${JOB}`);

  await page.getByTestId("cue-import-input").setInputFiles({
    name: "friday.cue",
    mimeType: "application/octet-stream",
    buffer: Buffer.from('TRACK 01 AUDIO\n TITLE "First"\n INDEX 01 00:00:00\n'),
  });

  // Repeated rekordbox entries are skipped unless the user opts out.
  await expect(page.getByTestId("cue-import-confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("cue-import-skip-repeats")).toBeChecked();
  await page.getByTestId("cue-import-confirm").click();

  await expect(page.getByTestId("tracklist-row")).toHaveCount(2);
  expect(calls.cueUploads).toHaveLength(1);
  expect(calls.cueUploads[0]).toContain('filename="friday.cue"');
  expect(calls.cueUploads[0]).toMatch(/name="skip_repeats"\s+true/);
  await expect(
    page.getByText(
      "Imported 2 tracks, skipped 1 repeated entry, 2 linked to SoundCloud",
    ),
  ).toBeVisible();
});

test("can keep repeated CUE entries", async ({ page }) => {
  const calls = await mockJob(page);
  await page.goto(`/breakdown?job=${JOB}`);

  await page.getByTestId("cue-import-input").setInputFiles({
    name: "friday.cue",
    mimeType: "application/octet-stream",
    buffer: Buffer.from('TRACK 01 AUDIO\n TITLE "First"\n INDEX 01 00:00:00\n'),
  });
  await page.getByTestId("cue-import-skip-repeats").click();
  await page.getByTestId("cue-import-confirm").click();

  await expect(page.getByTestId("tracklist-row")).toHaveCount(2);
  expect(calls.cueUploads[0]).toMatch(/name="skip_repeats"\s+false/);
});

test("asks before a CUE sheet replaces an existing tracklist", async ({
  page,
}) => {
  const calls = await mockJob(page, { timeline: TRACKS.slice(0, 1) });
  await page.goto(`/breakdown?job=${JOB}`);
  await expect(page.getByTestId("tracklist-row")).toHaveCount(1);

  await page.getByTestId("cue-import-input").setInputFiles({
    name: "friday.cue",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("TRACK 01 AUDIO\n INDEX 01 00:00:00\n"),
  });

  await expect(page.getByTestId("cue-import-confirm-dialog")).toBeVisible();
  expect(calls.cueUploads).toHaveLength(0);
  await page.getByTestId("cue-import-confirm").click();

  await expect(page.getByTestId("tracklist-row")).toHaveCount(2);
  expect(calls.cueUploads).toHaveLength(1);
});

test("measuring switches the top chart to LUFS, with peaks over the ceiling marked", async ({
  page,
}) => {
  await mockJob(page, { timeline: TRACKS });
  await page.goto(`/breakdown?job=${JOB}`);

  const toggle = page.getByTestId("timeline-chart-toggle");
  await expect(page.getByTestId("bpm-lane")).toBeVisible();
  await expect(toggle.getByTestId("timeline-chart-lufs")).toBeDisabled();

  await page.getByTestId("loudness-measure").click();

  const lane = page.getByTestId("lufs-lane");
  await expect(lane).toBeVisible();
  await expect(page.getByTestId("bpm-lane")).toHaveCount(0);
  await expect(lane.getByTestId("lufs-median-line")).toHaveCount(1);
  await expect(lane.getByTestId("lufs-peak-over")).toHaveCount(1);

  await lane.hover({ position: { x: 20, y: 60 } });
  await expect(page.getByTestId("hover-tooltip")).toContainText("-8.0 LUFS");

  await toggle.getByTestId("timeline-chart-bpm").click();
  await expect(page.getByTestId("bpm-lane")).toBeVisible();
  await expect(lane).toHaveCount(0);

  // The choice is remembered.
  await toggle.getByTestId("timeline-chart-lufs").click();
  await page.reload();
  await expect(page.getByTestId("lufs-lane")).toBeVisible();
});

test("flags transition jumps and bass balance, and shows each track's loudness", async ({
  page,
}) => {
  await mockJob(page, { timeline: TRACKS, measured: true });
  await page.goto(`/breakdown?job=${JOB}`);

  const transition = page.getByTestId("loudness-transition");
  await expect(transition).toHaveCount(1);
  await expect(transition).toContainText("A - First → B - Second");
  await expect(transition.getByTestId("loudness-transition-jump")).toHaveText(
    "-3.7 LU",
  );

  // Bass against the median (-5 LU): only the first track is 2 LU or more off.
  const lowEnd = page.getByTestId("loudness-low-end-row");
  await expect(lowEnd).toHaveCount(1);
  await expect(lowEnd).toContainText("more bass");
  await expect(lowEnd.getByTestId("loudness-low-end-offset")).toHaveText(
    "+3.0 LU",
  );

  const rows = page.getByTestId("tracklist-row");
  await expect(rows.first().getByTestId("tracklist-lufs")).toHaveText(
    "-8.0 LUFS",
  );
  const peak = rows.first().getByTestId("tracklist-true-peak");
  await expect(peak).toHaveText("TP -0.6");
  await expect(peak).toHaveClass(/text-danger/);
  await expect(rows.nth(1).getByTestId("tracklist-true-peak")).not.toHaveClass(
    /text-danger/,
  );
});

test("shows how far the measurement is while it runs", async ({ page }) => {
  let finish = () => {};
  const measureDone = new Promise<void>((resolve) => (finish = resolve));
  await mockJob(page, { timeline: TRACKS, progress: 0.42, measureDone });
  await page.goto(`/breakdown?job=${JOB}`);

  await page.getByTestId("loudness-measure").click();

  const progress = page.getByTestId("loudness-progress");
  await expect(progress.getByTestId("loudness-progress-percent")).toHaveText(
    "42%",
  );
  await expect(progress.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "42",
  );

  finish();
  await expect(page.getByTestId("loudness-summary")).toBeVisible();
  await expect(progress).toHaveCount(0);
});

async function mockReference(
  page: Page,
  opts: { measured: boolean; id?: string; report?: unknown },
) {
  const id = opts.id ?? REFERENCE_JOB;
  let measured = opts.measured;
  const calls = { measure: 0 };
  await page.route(
    new RegExp(`/api/breakdown/sets/${id}/loudness/progress$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ progress: null }),
      }),
  );
  await page.route(
    new RegExp(`/api/breakdown/sets/${id}/loudness$`),
    (route) => {
      if (route.request().method() === "POST") {
        calls.measure += 1;
        measured = true;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          report: measured ? (opts.report ?? REFERENCE_REPORT) : null,
        }),
      });
    },
  );
  return calls;
}

const JOBS = [jobSummary(JOB, "friday"), jobSummary(REFERENCE_JOB, "Pro mix")];

test("compares loudness and tonal balance with another set", async ({
  page,
}) => {
  await mockJob(page, { timeline: TRACKS, measured: true, jobs: JOBS });
  await mockReference(page, { measured: true });
  await page.goto(`/breakdown?job=${JOB}`);

  const panel = page.getByTestId("compare-panel");
  await panel.getByTestId("compare-reference").click();
  // The set being viewed isn't offered as its own reference.
  const options = page.getByTestId("compare-reference-option");
  await expect(options).toHaveCount(1);
  await options.getByText("Pro mix").click();
  await page.keyboard.press("Escape");

  const readings = panel.getByTestId("compare-readings-row");
  await expect(readings.first()).toContainText("Integrated");
  await expect(
    readings.first().getByTestId("compare-readings-diff"),
  ).toHaveText("-3.1");
  const peakToLoudness = readings.filter({ hasText: "Peak to loudness" });
  await expect(peakToLoudness).toContainText("9.8");
  await expect(peakToLoudness).toContainText("6.3");
  await expect(peakToLoudness.getByTestId("compare-readings-diff")).toHaveText(
    "+3.5",
  );

  const bandRows = panel.getByTestId("compare-bands-row");
  await expect(bandRows).toHaveCount(6);
  const highMid = bandRows.filter({ hasText: "High mid 2k–6k" });
  await expect(highMid.getByTestId("compare-bands-diff")).toHaveText("+1.6");

  const spectrum = panel.getByTestId("compare-spectrum");
  await expect(spectrum.getByTestId("compare-spectrum-mine")).toBeAttached();
  await expect(
    spectrum.getByTestId("compare-spectrum-reference"),
  ).toBeAttached();
  await expect(panel.getByTestId("compare-set")).toContainText("Pro mix");
});

test("measures an unmeasured reference from the compare panel", async ({
  page,
}) => {
  await mockJob(page, { timeline: TRACKS, measured: true, jobs: JOBS });
  const calls = await mockReference(page, { measured: false });
  await page.goto(`/breakdown?job=${JOB}`);

  const panel = page.getByTestId("compare-panel");
  await panel.getByTestId("compare-reference").click();
  await page.getByTestId("compare-reference-option").click();
  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("compare-readings")).toHaveCount(0);

  await panel.getByTestId("compare-measure-reference").click();

  await expect(panel.getByTestId("compare-readings")).toBeVisible();
  expect(calls.measure).toBe(1);
});

test("compares with several sets against their average", async ({ page }) => {
  const club = { ...REFERENCE_REPORT, integrated_lufs: -9.3 };
  await mockJob(page, {
    timeline: TRACKS,
    measured: true,
    jobs: [
      ...JOBS,
      jobSummary("club-mix-job", "Club mix"),
      jobSummary("old-master-job", "Old master"),
      jobSummary("warmup-job", "Warmup"),
    ],
  });
  await mockReference(page, { measured: true });
  await mockReference(page, {
    measured: true,
    id: "club-mix-job",
    report: club,
  });
  await mockReference(page, { measured: false, id: "old-master-job" });
  await page.goto(`/breakdown?job=${JOB}`);

  const panel = page.getByTestId("compare-panel");
  await panel.getByTestId("compare-reference").click();
  const options = page.getByTestId("compare-reference-option");
  // The menu stays open to pick several sets in a row.
  await options.filter({ hasText: "Pro mix" }).click();
  await options.filter({ hasText: "Club mix" }).click();
  await options.filter({ hasText: "Old master" }).click();
  // Three is the most: the rest can't be picked.
  await expect(options.filter({ hasText: "Warmup" })).toHaveAttribute(
    "data-disabled",
    "",
  );
  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("compare-reference")).toHaveText(
    "3 of 3 sets",
  );

  const sets = panel.getByTestId("compare-set");
  await expect(sets).toHaveCount(3);
  // The unmeasured one waits for its own Measure; the others compare now.
  await expect(
    sets
      .filter({ hasText: "Old master" })
      .getByTestId("compare-measure-reference"),
  ).toBeVisible();
  const integrated = panel.getByTestId("compare-readings-row").first();
  await expect(integrated.locator("td")).toHaveText([
    "Integrated (LUFS)",
    "-10.4",
    "-7.3",
    "-9.3",
    "-2.1",
  ]);
  await expect(panel.getByTestId("compare-spectrum-reference")).toHaveCount(2);
});

test("previews a bell EQ and shows the tonal balance it would give", async ({
  page,
}) => {
  await mockJob(page, { timeline: TRACKS, measured: true, jobs: JOBS });
  await mockReference(page, { measured: true });
  await page.goto(`/breakdown?job=${JOB}`);

  const eqPanel = page.getByTestId("eq-panel");
  const toggle = eqPanel.getByTestId("eq-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(eqPanel.getByTestId("eq-ableton")).toContainText(
    "Bell, 3.00 kHz, +1.0 dB, Q 0.70",
  );

  const compare = page.getByTestId("compare-panel");
  await compare.getByTestId("compare-reference").click();
  await page.getByTestId("compare-reference-option").click();
  await page.keyboard.press("Escape");
  const highMid = compare
    .getByTestId("compare-bands-row")
    .filter({ hasText: "High mid" });
  const thisSet = highMid.locator("td").nth(1);
  await expect(thisSet).toHaveText("-13.0");
  await expect(compare.getByTestId("compare-spectrum-before-eq")).toHaveCount(
    0,
  );

  await toggle.click();

  // The boost at 3 kHz raises the high mid's share and draws the set without it faintly.
  await expect(thisSet).not.toHaveText("-13.0");
  expect(Number(await thisSet.textContent())).toBeGreaterThan(-13);
  await expect(compare.getByTestId("compare-sets")).toContainText(
    "This set with the EQ",
  );
  await expect(
    compare.getByTestId("compare-spectrum-before-eq"),
  ).toBeAttached();

  // Gain moves in 0.1 dB steps from the keyboard.
  await eqPanel.getByTestId("eq-gain-control").getByRole("slider").focus();
  await page.keyboard.press("ArrowRight");
  await expect(eqPanel.getByTestId("eq-gain")).toHaveText("+1.1 dB");
  await expect(eqPanel.getByTestId("eq-ableton")).toContainText(
    "Bell, 3.00 kHz, +1.1 dB, Q 0.70",
  );

  // Switching off is the A/B: the set's own reading comes back.
  await toggle.click();
  await expect(thisSet).toHaveText("-13.0");

  // The settings are remembered.
  await page.reload();
  await expect(page.getByTestId("eq-gain")).toHaveText("+1.1 dB");
});

/** Close the reference menu and wait out its exit animation. */
async function closeMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("compare-reference-option")).toHaveCount(0);
}

test("A/B listens between this set and a reference, level-matched", async ({
  page,
}) => {
  await mockJob(page, {
    timeline: TRACKS,
    measured: true,
    jobs: [...JOBS, jobSummary("club-mix-job", "Club mix")],
  });
  await mockReference(page, { measured: true });
  await mockReference(page, { measured: true, id: "club-mix-job" });
  const referenceAudio: string[] = [];
  await page.route(
    new RegExp(`/api/breakdown/sets/${REFERENCE_JOB}/audio$`),
    (route) => {
      referenceAudio.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "audio/wav", body: "" });
    },
  );
  await page.goto(`/breakdown?job=${JOB}`);

  const compare = page.getByTestId("compare-panel");
  await compare.getByTestId("compare-reference").click();
  await page
    .getByTestId("compare-reference-option")
    .filter({ hasText: "Pro mix" })
    .click();
  await closeMenu(page);

  const sets = compare.getByTestId("compare-sets");
  const thisSet = sets.locator("li").first();
  const reference = compare.getByTestId("compare-set");
  await expect(compare.getByTestId("compare-listen")).toHaveCount(2);
  await expect(compare.getByTestId("compare-listen-gain")).toHaveCount(0);
  // Nothing extra streams until A/B is used.
  expect(referenceAudio).toHaveLength(0);

  await reference.getByTestId("compare-listen").click();

  await expect(reference.getByTestId("compare-listen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(reference.getByTestId("compare-listen")).toHaveText("Hearing");
  await expect(thisSet.getByTestId("compare-listen")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect.poll(() => referenceAudio.length).toBeGreaterThan(0);
  // The reference is 3.1 LU louder, so it plays turned down; this set is the quietest.
  await expect(reference.getByTestId("compare-listen-gain")).toHaveText(
    "-3.1 dB",
  );
  await expect(thisSet.getByTestId("compare-listen-gain")).toHaveCount(0);

  await thisSet.getByTestId("compare-listen").click();
  await expect(thisSet.getByTestId("compare-listen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await compare.getByTestId("compare-level-match").click();
  await expect(compare.getByTestId("compare-listen-gain")).toHaveCount(0);

  // Unpicking the reference being heard falls back to this set.
  await compare.getByTestId("compare-reference").click();
  await page
    .getByTestId("compare-reference-option")
    .filter({ hasText: "Club mix" })
    .click();
  await closeMenu(page);
  await reference
    .filter({ hasText: "Pro mix" })
    .getByTestId("compare-listen")
    .click();
  await compare.getByTestId("compare-reference").click();
  await page
    .getByTestId("compare-reference-option")
    .filter({ hasText: "Pro mix" })
    .click();
  await closeMenu(page);
  await expect(reference).toHaveCount(1);
  await expect(thisSet.getByTestId("compare-listen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
