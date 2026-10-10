import type { Page, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Track Breakdown: the Set/Track toggle, picking a track, job progress,
 * the analysed timeline, section edits, stem mute/solo, zoom and the
 * library entry point. The backend is mocked; stems are a silent WAV.
 */

const PATH = "/music/collection/Artist - Tune.aiff";
const DIGEST = "d1g35t";
const N_BARS = 48;
const BPM = 128;

const SECTIONS = [
  { start_bar: 1, end_bar: 16, label: "intro" },
  { start_bar: 17, end_bar: 32, label: "groove" },
  { start_bar: 33, end_bar: 48, label: "breakdown" },
];

function source(level: number) {
  return {
    db: Array.from({ length: N_BARS }, () => level),
    bands_db: Array.from({ length: N_BARS }, () => [
      level,
      level,
      level,
      level,
      level,
      -18,
    ]),
    centroid_hz: Array.from({ length: N_BARS }, () => 4000),
    width: Array.from({ length: N_BARS }, (_, i) => (i >= 32 ? 0.6 : 0.02)),
    onset: Array.from({ length: N_BARS }, () => 0.1),
  };
}

const grooveLane = () =>
  Array.from({ length: N_BARS }, () =>
    Array.from({ length: 16 }, (_, slot) => (slot % 4 === 0 ? 0 : -40)),
  );

function breakdown(sections = SECTIONS, edited = false) {
  return {
    digest: DIGEST,
    features: {
      pipeline_version: 1,
      sample_rate: 44100,
      duration_s: (N_BARS * 240) / BPM,
      grid: {
        bpm: BPM,
        bpm_rough: BPM,
        concentration: 0.1,
        downbeat_s: 0.25,
        bar_s: 240 / BPM,
        n_bars: N_BARS,
        beats_per_bar: 4,
      },
      bands_hz: [
        [20, 60],
        [60, 150],
        [150, 500],
        [500, 2000],
        [2000, 6000],
        [6000, 20000],
      ],
      sources: {
        mix: source(-1),
        drums: source(-6),
        bass: source(-8),
        other: source(-14),
        vocals: source(-70),
      },
      groove: {
        kick: grooveLane(),
        bass: grooveLane(),
        drum_mids: grooveLane(),
        drum_tops: grooveLane(),
      },
      tonal: {
        root: "A",
        bass_peaks: [{ hz: 55, note: "A1", db: 0 }],
        chroma: Array.from({ length: N_BARS }, () => Array(12).fill(0)),
      },
    },
    sections,
    detected_sections: SECTIONS,
    sections_edited: edited,
    grid_edited: false,
  };
}

/** One second of 16-bit mono silence as a WAV file. */
function silentWav(): Buffer {
  const rate = 8000;
  const samples = Math.ceil((rate * N_BARS * 240) / BPM);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

interface Mocks {
  savedSections: unknown[];
  cancelled: number;
}

async function mockTrackApi(
  page: Page,
  events: object[] = [
    { type: "stage", stage: "hash", progress: null },
    { type: "complete", digest: DIGEST },
  ],
): Promise<Mocks> {
  const mocks: Mocks = { savedSections: [], cancelled: 0 };
  await page.route("**/api/breakdown/tracks/jobs", (route) =>
    route.fulfill({ json: { job_id: "job-1" } }),
  );
  await page.route("**/api/breakdown/tracks/jobs/job-1/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: sse(events) }),
  );
  await page.route("**/api/breakdown/tracks/jobs/job-1/cancel", (route) => {
    mocks.cancelled += 1;
    return route.fulfill({ json: { cancelled: true } });
  });
  await page.route(`**/api/breakdown/tracks/${DIGEST}/stems/*`, (route) =>
    route.fulfill({ contentType: "audio/wav", body: silentWav() }),
  );
  await page.route(/\/api\/metadata\/files\/.*\/audio$/, (route) =>
    route.fulfill({ contentType: "audio/wav", body: silentWav() }),
  );
  await page.route(
    `**/api/breakdown/tracks/${DIGEST}/sections`,
    (route: Route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({ json: breakdown() });
      }
      const body = route.request().postDataJSON() as {
        sections: typeof SECTIONS;
      };
      mocks.savedSections.push(body.sections);
      return route.fulfill({ json: breakdown(body.sections, true) });
    },
  );
  await page.route(`**/api/breakdown/tracks/${DIGEST}`, (route) =>
    route.fulfill({ json: breakdown() }),
  );
  return mocks;
}

const trackUrl = `/breakdown?view=track&path=${encodeURIComponent(PATH)}`;

test.describe("Track Breakdown", () => {
  test("the view toggle switches between Set and Track", async ({ page }) => {
    await page.goto("/breakdown");
    await expect(page.getByTestId("breakdown-start-screen")).toBeVisible();

    await page.getByRole("tab", { name: "Track" }).click();
    await expect(page).toHaveURL(/\/breakdown\?view=track$/);
    await expect(page.getByTestId("track-picker-input")).toBeVisible();

    await page.getByRole("tab", { name: "Set" }).click();
    await expect(page).toHaveURL(/\/breakdown\?view=set$/);
    await expect(page.getByTestId("breakdown-start-screen")).toBeVisible();
  });

  test("picking a track from the collection opens its breakdown", async ({
    page,
  }) => {
    await mockTrackApi(page);
    await page.route("**/api/metadata/folders/collection/browse*", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              file_path: PATH,
              file_name: "Artist - Tune.aiff",
              title: "Tune",
              artist: "Artist",
            },
          ],
          total: 1,
          page: 1,
          size: 12,
          pages: 1,
        },
      }),
    );
    await page.goto("/breakdown?view=track");
    await page.getByTestId("track-picker-input").fill("tune");
    await page.getByTestId("track-picker-result").click();

    await expect(page).toHaveURL(
      new RegExp(`path=${encodeURIComponent(PATH).replace(/[.]/g, "\\.")}`),
    );
    await expect(page.getByTestId("track-bpm")).toHaveText("128 BPM");
  });

  test("recent tracks reopen and delete their breakdown", async ({ page }) => {
    await mockTrackApi(page);
    let tracks = [
      {
        digest: DIGEST,
        path: PATH,
        bpm: BPM,
        root: "A",
        n_bars: N_BARS,
        duration_s: 90,
        opened_at: 0,
        missing: false,
      },
      {
        digest: "gone",
        path: "/music/collection/Moved - Away.aiff",
        bpm: 140,
        root: null,
        n_bars: 64,
        duration_s: 110,
        opened_at: 0,
        missing: true,
      },
    ];
    let deleted: string | null = null;
    await page.route(/\/api\/breakdown\/tracks$/, (route) =>
      route.fulfill({ json: { tracks } }),
    );
    await page.route("**/api/breakdown/tracks/gone", (route) => {
      deleted = "gone";
      tracks = tracks.filter((t) => t.digest !== "gone");
      return route.fulfill({ status: 204 });
    });
    await page.goto("/breakdown?view=track");

    const rows = page.getByTestId("recent-track");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("128 BPM · A · 48 bars · 1:30");
    await expect(rows.nth(1)).toContainText("File not found");
    await expect(rows.nth(1).getByRole("button").first()).toBeDisabled();

    await rows.nth(1).getByTestId("delete-recent-track").click();
    await page.getByTestId("delete-recent-track-confirm").click();
    await expect(rows).toHaveCount(1);
    expect(deleted).toBe("gone");

    await rows.first().getByText("Artist - Tune").click();
    await expect(page.getByTestId("track-bpm")).toHaveText("128 BPM");
  });

  test("shows tempo, root, sections and stem lanes once analysed", async ({
    page,
  }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);

    await expect(page.getByTestId("track-breakdown-title")).toHaveText(
      "Artist - Tune",
    );
    await expect(page.getByTestId("track-bpm")).toHaveText("128 BPM");
    await expect(page.getByTestId("track-root")).toHaveText("A");
    await expect(page.getByTestId("track-section")).toHaveCount(3);
    await expect(page.getByTestId("track-section").nth(2)).toHaveAttribute(
      "data-label",
      "breakdown",
    );
    await expect(page.getByTestId("track-section-bars").first()).toHaveText(
      "16 bars",
    );
    await expect(
      page.getByTestId("track-lane-original").getByTestId("track-waveform"),
    ).toBeVisible();
    for (const lane of ["drums", "bass", "other", "vocals"]) {
      await expect(page.getByTestId(`track-waveform-${lane}`)).toBeVisible();
    }
    // The vocals stem is silent here, so it is labelled as FX rather than vocals.
    await expect(page.getByTestId("track-lane-vocals")).toContainText("FX");
    await expect(page.getByText("Loading stems…")).toHaveCount(0);
    await expect(page.getByTestId("track-play")).toBeEnabled();
    await expect(page.getByTestId("track-waveform")).toBeVisible();
    await expect(page.getByTestId("track-spectrum")).toBeVisible();
  });

  test("merging sections saves the edit and offers a reset", async ({
    page,
  }) => {
    const mocks = await mockTrackApi(page);
    await page.goto(trackUrl);

    await page.getByTestId("track-section").first().click({ button: "right" });
    await page.getByTestId("track-section-merge").click();

    await expect(page.getByTestId("track-section")).toHaveCount(2);
    expect(mocks.savedSections).toEqual([
      [
        { start_bar: 1, end_bar: 32, label: "intro" },
        { start_bar: 33, end_bar: 48, label: "breakdown" },
      ],
    ]);

    await page.getByTestId("track-sections-reset").click();
    await expect(page.getByTestId("track-section")).toHaveCount(3);
  });

  test("renaming a section saves the new label", async ({ page }) => {
    const mocks = await mockTrackApi(page);
    await page.goto(trackUrl);

    await page.getByTestId("track-section").nth(1).dblclick();
    await page.getByTestId("track-section-rename").fill("drop");
    await page.getByTestId("track-section-rename").press("Enter");

    await expect(page.getByTestId("track-section").nth(1)).toHaveAttribute(
      "data-label",
      "drop",
    );
    expect(mocks.savedSections.at(-1)).toEqual([
      SECTIONS[0],
      { start_bar: 17, end_bar: 32, label: "drop" },
      SECTIONS[2],
    ]);
  });

  test("mute and solo toggle per lane; the original starts muted", async ({
    page,
  }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);

    await expect(page.getByTestId("track-mute-original")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("track-solo-bass").click();
    await expect(page.getByTestId("track-solo-bass")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("track-mute-drums").click();
    await expect(page.getByTestId("track-mute-drums")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Muted and solo-silenced lanes are greyed out; the soloed one isn't.
    const audible = (lane: string) =>
      page.getByTestId(`track-lane-${lane}`).locator("[data-audible]");
    await expect(audible("original")).toHaveAttribute("data-audible", "false");
    await expect(audible("drums")).toHaveAttribute("data-audible", "false");
    await expect(audible("other")).toHaveAttribute("data-audible", "false");
    await expect(audible("bass")).toHaveAttribute("data-audible", "true");
  });

  test("drum parts expand under the drums lane", async ({ page }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);
    await expect(page.getByTestId("track-play")).toBeEnabled();

    const toggle = page.getByTestId("track-drum-parts-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("track-drum-part-kick")).toHaveCount(0);

    await toggle.click();
    for (const part of ["kick", "snare", "hats"]) {
      await expect(page.getByTestId(`track-waveform-${part}`)).toBeVisible();
    }
    await expect(page.getByTestId("track-drum-part-snare")).toContainText(
      "Snare",
    );

    // Soloing the kick plays the drums with only the kick.
    await page.getByTestId("track-solo-kick").click();
    const audible = (testId: string) =>
      page.getByTestId(testId).locator("[data-audible]");
    await expect(audible("track-drum-part-kick")).toHaveAttribute(
      "data-audible",
      "true",
    );
    await expect(audible("track-drum-part-hats")).toHaveAttribute(
      "data-audible",
      "false",
    );
    await expect(audible("track-lane-drums")).toHaveAttribute(
      "data-audible",
      "true",
    );
    await expect(audible("track-lane-bass")).toHaveAttribute(
      "data-audible",
      "false",
    );
    await page.getByTestId("track-solo-kick").click();
    await page.getByTestId("track-mute-hats").click();
    await expect(audible("track-drum-part-hats")).toHaveAttribute(
      "data-audible",
      "false",
    );
    await expect(audible("track-drum-part-kick")).toHaveAttribute(
      "data-audible",
      "true",
    );

    await toggle.click();
    await expect(page.getByTestId("track-drum-part-kick")).toHaveCount(0);
  });

  test("curves expand under the original lane", async ({ page }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);

    const toggle = page.getByTestId("track-curves-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("track-lane-curves")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Loudness" })).toBeVisible();
  });

  test("bar and sections stay pinned while the lanes scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await mockTrackApi(page);
    await page.goto(trackUrl);
    await page.getByTestId("track-drum-parts-toggle").click();

    const lanes = page.getByTestId("track-lanes");
    await lanes.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect
      .poll(() => lanes.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    const lanesTop = (await lanes.boundingBox())!.y;
    const pinnedTop = (await page
      .getByTestId("track-pinned-lanes")
      .boundingBox())!.y;
    expect(Math.abs(pinnedTop - lanesTop)).toBeLessThan(2);
  });

  test("hovering the spectrum reads out frequency and note", async ({
    page,
  }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);

    const spectrum = page.getByTestId("track-spectrum");
    const readout = page.getByTestId("track-spectrum-readout");
    await expect(readout).toBeHidden();

    // The axis is log-scaled from 20 Hz to 20 kHz, so the middle is 632 Hz (D#5).
    const box = (await spectrum.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(readout).toBeVisible();
    await expect(readout).toContainText("Hz");
    await expect(readout).toContainText("D#5");

    await page.mouse.move(box.x + box.width / 2, box.y - 40);
    await expect(readout).toBeHidden();
  });

  test("stop returns to the cue set by clicking, like Ableton", async ({
    page,
  }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);
    await expect(page.getByTestId("track-play")).toBeEnabled();

    // 48 bars across the plot, so its middle is bar 25.
    const plot = page.getByTestId("track-waveform-bass");
    const box = (await plot.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const position = page.getByTestId("track-position");
    await expect(position).toContainText("Bar 25.0");
    await expect(page.getByTestId("track-cue")).toHaveAttribute(
      "data-cue-bar",
      "25",
    );

    await page.keyboard.press("Space");
    await expect(position).not.toContainText("Bar 25.0");
    await page.keyboard.press("Space");
    await expect(position).toContainText("Bar 25.0");

    // Shift+Space pauses in place instead.
    await page.keyboard.press("Space");
    await expect(position).not.toContainText("Bar 25.0");
    await page.keyboard.press("Shift+Space");
    await expect(page.getByTestId("track-play")).toHaveAttribute(
      "aria-label",
      "Play",
    );
    await expect(position).not.toContainText("Bar 25.0");
  });

  test("looping the section at the playhead", async ({ page }) => {
    await mockTrackApi(page);
    await page.goto(trackUrl);

    await page.getByTestId("track-loop").click();
    await expect(page.getByTestId("track-loop")).toHaveText(/Looping intro/);
    await expect(page.getByTestId("track-loop")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("shows stem separation progress and cancels the job", async ({
    page,
  }) => {
    const mocks = await mockTrackApi(page, [
      { type: "stage", stage: "hash", progress: null },
      { type: "stage", stage: "stems", progress: 0.5 },
    ]);
    await page.goto(trackUrl);

    await expect(page.getByTestId("track-breakdown-progress")).toBeVisible();
    await expect(page.getByTestId("track-stems-percent")).toHaveText("50%");
    await page.getByTestId("track-breakdown-cancel").click();
    await expect.poll(() => mocks.cancelled).toBe(1);
  });

  test("shows drum splitting progress after the stems", async ({ page }) => {
    await mockTrackApi(page, [
      { type: "stage", stage: "hash", progress: null },
      { type: "stage", stage: "stems", progress: 1 },
      { type: "stage", stage: "drum_parts", progress: 0.25 },
    ]);
    await page.goto(trackUrl);

    await expect(page.getByTestId("track-drums-percent")).toHaveText("25%");
    await expect(page.getByTestId("track-stems-percent")).toHaveCount(0);
  });

  test("offers stem separation setup when Demucs is missing", async ({
    page,
  }) => {
    let setupStatus = "missing";
    let installs = 0;
    let polls = 0;
    await mockTrackApi(page, [
      {
        type: "error",
        code: "stems_unavailable",
        message: "Stem separation isn't set up yet.",
      },
    ]);
    await page.route("**/api/breakdown/stem-separation/install", (route) => {
      installs += 1;
      setupStatus = "installing";
      return route.fulfill({
        json: { status: "installing", stage: "uv", error: null, size_bytes: 0 },
      });
    });
    await page.route("**/api/breakdown/stem-separation", (route) => {
      if (setupStatus === "installing" && ++polls >= 2) setupStatus = "ready";
      return route.fulfill({
        json: {
          status: setupStatus,
          stage: setupStatus === "installing" ? "packages" : null,
          error: null,
          size_bytes: setupStatus === "ready" ? 832 * 2 ** 20 : 0,
        },
      });
    });
    await page.goto(trackUrl);

    await expect(page.getByTestId("track-breakdown-failed")).toContainText(
      "isn't set up",
    );
    await page.getByTestId("stem-setup-install").click();
    await expect(page.getByTestId("stem-setup-stage")).toBeVisible();
    expect(installs).toBe(1);
    // Once ready the job re-runs; the mocked stream errors again, so the
    // view shows the setup panel in its ready state.
    await expect(page.getByTestId("stem-setup")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 10_000 },
    );
  });

  test("library rows open in Breakdown from the context menu", async ({
    page,
  }) => {
    const row = {
      file_path: PATH,
      file_name: "Artist - Tune.aiff",
      file_format: ".aiff",
      has_artwork: false,
      title: "Tune",
      artist: "Artist",
    };
    const browse = (route: Route) =>
      route.fulfill({
        json: { items: [row], total: 1, page: 1, size: 50, pages: 1 },
      });
    await page.route("**/api/metadata/folders/*/browse*", browse);
    await page.route(/\/api\/metadata\/folders\/browse-path\?/, browse);
    await mockTrackApi(page);

    await page.goto("/library");
    await page.locator("[data-index]").first().click({ button: "right" });
    await page.getByTestId("open-in-breakdown").click();

    await expect(page).toHaveURL(/\/breakdown\?view=track&path=/);
    await expect(page.getByTestId("track-bpm")).toHaveText("128 BPM");
  });
});

test.describe("Breakdown settings", () => {
  test("sets up stem separation and saves the stems folder", async ({
    page,
  }) => {
    let saved: Record<string, unknown> | null = null;
    let installed = false;
    await page.route(/\/api\/settings$/, (route) => {
      if (route.request().method() === "PUT") {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: saved });
      }
      return route.fulfill({
        json: {
          preferred_output_format: "aiff",
          root_music_folder: "/music",
          breakdown_cache_dir: "",
        },
      });
    });
    await page.route("**/api/breakdown/stem-separation/install", (route) => {
      installed = true;
      return route.fulfill({
        json: {
          status: "ready",
          stage: null,
          error: null,
          size_bytes: 832 * 2 ** 20,
        },
      });
    });
    await page.route("**/api/breakdown/stem-separation", (route) =>
      route.fulfill({
        json: installed
          ? {
              status: "ready",
              stage: null,
              error: null,
              size_bytes: 832 * 2 ** 20,
            }
          : { status: "missing", stage: null, error: null, size_bytes: 0 },
      }),
    );
    await page.goto("/library");
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Breakdown" }).click();

    await page.getByTestId("stem-setup-install").click();
    await expect(page.getByTestId("stem-setup")).toContainText(
      "ready · 832 MB",
    );

    await page.getByLabel("Stems folder").fill("/Volumes/Data/stems");
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => saved)
      .toEqual({
        breakdown_cache_dir: "/Volumes/Data/stems",
      });
  });
});
