import type { Page, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

/** Silent mono WAV of `seconds` at 8kHz so `duration` resolves and playback
 * runs long enough to reach the auto-mix mix-out point before the track ends. */
function makeSilentWav(seconds: number): Buffer {
  const rate = 8000;
  const numSamples = rate * seconds;
  const buf = Buffer.alloc(44 + numSamples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(numSamples, 40);
  buf.fill(0x80, 44);
  return buf;
}

function jsonRoute(body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

function rekTrack(id: string, title: string, path: string) {
  return {
    id,
    title,
    artist: "Bar",
    album: null,
    genre: "House",
    bpm: 124,
    key: "8A",
    duration_seconds: 350,
    file_path: path,
    comment: null,
    soundcloud_id: null,
    date_added: "2024-01-15",
    release_date: null,
    has_artwork: true,
    has_waveform: true,
  };
}

const TRACK_A = rekTrack("t-1", "Foo", "/music/foo.flac");
const TRACK_B = rekTrack("t-2", "Baz", "/music/baz.flac");

const PLAYLISTS = [
  {
    id: "pl-1",
    name: "Sunday Mix",
    parent_id: null,
    is_folder: false,
    is_smart: false,
    track_count: 2,
  },
];

const ANALYSIS = {
  beatgrid: [
    { beat: 1, bpm: 124, timeMs: 0 },
    { beat: 2, bpm: 124, timeMs: 484 },
    { beat: 3, bpm: 124, timeMs: 968 },
    { beat: 4, bpm: 124, timeMs: 1452 },
  ],
  sections: [{ kind: "intro", label: "Intro", startMs: 0, endMs: 1452 }],
  cues: [],
};

/**
 * A multi-bar 4/4 beatgrid, one beat every `stepMs`, spanning `endMs`. The
 * single-bar `ANALYSIS` above falls back to a plain crossfade (a beatgrid mix
 * needs several downbeats), so the beatgrid specs override the analysis route
 * with this to actually exercise the bar-aligned strategy.
 */
function denseGrid(stepMs: number, endMs: number, kind: string) {
  const beatgrid = [];
  for (let t = 0, beat = 1; t <= endMs; t += stepMs, beat = (beat % 4) + 1) {
    beatgrid.push({ beat, bpm: 124, timeMs: t });
  }
  return {
    beatgrid,
    sections: [{ kind, label: kind, startMs: 0, endMs }],
    cues: [],
  };
}

test.describe("Auto-mix crossfade", { tag: "@slow" }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      "**/api/rekordbox/status",
      jsonRoute({ available: true, reason: null }),
    );
    await page.route(
      "**/api/rekordbox/playlists",
      jsonRoute({ playlists: PLAYLISTS }),
    );
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks",
      jsonRoute({ tracks: [TRACK_A, TRACK_B] }),
    );
    await page.route("**/api/rekordbox/tracks/*/artwork*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: TINY_JPEG,
      }),
    );
    await page.route("**/api/rekordbox/tracks/*/waveform*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: Buffer.alloc(7200),
      }),
    );
    // Track B gets a distinct section label so specs can assert the phrase
    // band flips to the incoming track at the swipe.
    await page.route("**/api/rekordbox/tracks/*/analysis*", (route) => {
      const isTrackB = route.request().url().includes("/t-2/");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...ANALYSIS,
          sections: isTrackB
            ? [{ kind: "chorus", label: "Drop", startMs: 0, endMs: 1452 }]
            : ANALYSIS.sections,
        }),
      });
    });
    await page.route(
      "**/api/metadata/files/*/peaks*",
      jsonRoute({ peaks: Array(200).fill(0.3) }),
    );
    // ~10s of audio so the default 6s fade leaves a real mix-out point (~4s in).
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(10),
      }),
    );
  });

  async function playFirst(page: Page) {
    await page.goto("/library?source=rekordbox");
    await page.getByText("Sunday Mix").click();
    const tracks = page.getByTestId("rekordbox-tracks");
    await tracks.getByRole("button", { name: "Play Foo" }).click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();
  }

  test("crossfades into the next queued track and adopts it", async ({
    page,
  }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");
    await expect(player.getByText("Foo", { exact: true })).toBeVisible();

    // Open the zoom detail strip so the split view is exercised during the fade.
    await player.getByTestId("player-detail-toggle").click();

    // Enable auto-mix (time crossfade — the default mode).
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    // The fade fires at the mix-out point: the player enters the transitioning
    // state, then the incoming track ("Baz") becomes the current track.
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // The incoming-track preview chip and the crossfade overview overlay are
    // visible while the fade runs.
    await expect(player.getByTestId("player-next-chip")).toBeVisible();
    await expect(player.getByTestId("player-next-chip")).toContainText("Baz");
    await expect(player.getByTestId("player-crossfade-overview")).toBeVisible();
    // Before the swipe the out-going track is the master: its layer renders at
    // natural scale, untransformed — the waveform must not stretch or shift
    // the moment the incoming track appears.
    await expect(
      player
        .getByTestId("player-overview-swipe")
        .locator(":scope > div")
        .first(),
    ).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    // Each deck keeps a visible playhead in the overview through the fade.
    await expect(
      player.getByTestId("player-overview-playhead-old"),
    ).toBeVisible();
    await expect(
      player.getByTestId("player-overview-playhead-new"),
    ).toBeVisible();
    // The zoom detail strip splits into two stacked scrolling decks (incoming
    // on top, out-going on bottom) during the fade. Each deck is clipped by a
    // dynamic polygon (half height across the overlap, full height outside it).
    const split = player.getByTestId("player-detail-split");
    await expect(split).toBeVisible();
    await expect(split.locator(":scope > div").first()).toHaveCSS(
      "clip-path",
      /polygon/,
    );
    // A green divider marks the half split across the overlap — the two decks
    // above/below it play separately.
    await expect(
      player.getByTestId("player-detail-split-divider"),
    ).toBeVisible();
    // The overview swipe carries the same half-split divider across its
    // overlap region.
    await expect(
      player.getByTestId("player-overview-split-divider"),
    ).toBeVisible();
    // The incoming deck's zoom canvas must survive adoption in place (keyed
    // reconciliation) — a remount repaints from blank, which flickers.
    const incomingCanvas = await split
      .locator(":scope > div")
      .nth(1)
      .locator("canvas")
      .elementHandle();
    // Until the swipe, the phrase band shows the out-going track's sections.
    await expect(player.getByTestId("player-section")).toContainText("Intro");
    // At the fade midpoint the overview swipes: the incoming layer settles at
    // its true scale (identity transform), i.e. the view is scaled to the new
    // track.
    const newLayer = player
      .getByTestId("player-overview-swipe")
      .locator(":scope > div")
      .nth(1);
    await expect(newLayer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)", {
      timeout: 15000,
    });
    // The phrase band flips with the swipe to the incoming track's sections —
    // not only after the old track runs out.
    await expect(player.getByTestId("player-section")).toContainText("Drop");
    // Rail title flips to the incoming track (the next-chip also says "Baz"
    // mid-fade, so target the title attribute).
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    // Deck B was adopted, so the fade settles back out of the transition state.
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      {
        timeout: 15000,
      },
    );
    // Same canvas element, still in the DOM — the zoom strip did not remount.
    expect(await incomingCanvas!.evaluate((el) => el.isConnected)).toBe(true);
  });

  test("advances past a same-file queue entry after the crossfade", async ({
    page,
  }) => {
    // Queues are built verbatim from listings, so the same file can sit twice
    // in a row. The crossfade into the duplicate must still adopt and settle
    // (regression: the player keyed its init effect on filePath alone, so the
    // advance never re-initialized and the player wedged in "transitioning").
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks",
      jsonRoute({
        tracks: [TRACK_A, rekTrack("t-2", "Foo", "/music/foo.flac")],
      }),
    );

    await page.goto("/library?source=rekordbox");
    await page.getByText("Sunday Mix").click();
    const tracks = page.getByTestId("rekordbox-tracks");
    await tracks.getByRole("button", { name: "Play Foo" }).first().click();
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // The fade completes into the duplicate entry: the player must leave the
    // transitioning state and settle back to idle (no further queue entries).
    await expect(player).toHaveAttribute("data-mix-state", "idle", {
      timeout: 15000,
    });
    // The adopted duplicate keeps playing.
    await expect(player.getByTitle("Foo", { exact: true })).toBeVisible();
    await expect(player.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("changing the fade length after arming does not re-download the next track", async ({
    page,
  }) => {
    // Regression: every knob change re-ran the whole arming effect, tearing
    // down deck B and re-fetching + re-decoding the entire next track per
    // fade-length slider step. The prepared deck must survive replanning.
    let bazAudioFetches = 0;
    // Long track so the mix-out point stays comfortably ahead while the
    // slider is stepped.
    await page.route("**/api/metadata/files/*/audio", (route) => {
      if (route.request().url().includes("baz")) bazAudioFetches += 1;
      return route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(60),
      });
    });

    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await expect(player).toHaveAttribute("data-mix-state", "armed", {
      timeout: 15000,
    });
    expect(bazAudioFetches).toBe(1);

    // Step the fade length 6s → 11s; each step updates the mix config and
    // recomputes the plan.
    const slider = page.getByTestId("mix-crossfade-seconds");
    await slider.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await expect(
      page.getByTestId("mix-crossfade-seconds-readout"),
    ).toContainText("11s");

    // The plan recomputed, but deck B was not torn down and re-decoded.
    await page.waitForTimeout(1000);
    await expect(player).toHaveAttribute("data-mix-state", "armed");
    expect(bazAudioFetches).toBe(1);
  });

  test("mode settings render inside the selected mode card", async ({
    page,
  }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");
    await player.getByTestId("mix-controls-trigger").click();

    // Crossfade is the default mode: its card holds the fade-length slider.
    const crossfadeCard = page.getByTestId("mix-mode-crossfade-card");
    await expect(
      crossfadeCard.getByTestId("mix-crossfade-seconds"),
    ).toBeVisible();

    // Selecting Beatgrid moves the settings into its card.
    await page.getByTestId("mix-mode-beatgrid").click();
    const beatgridCard = page.getByTestId("mix-mode-beatgrid-card");
    await expect(beatgridCard.getByTestId("mix-bars-16")).toBeVisible();
    await expect(beatgridCard.getByTestId("mix-section-aware")).toBeVisible();
    await expect(page.getByTestId("mix-crossfade-seconds")).toHaveCount(0);
    // Rekordbox tracks carry a beatgrid — no fallback warning.
    await expect(page.getByTestId("mix-beatgrid-unavailable")).toHaveCount(0);

    // Beatgrid + EQ reuses the same bar-aligned settings.
    await page.getByTestId("mix-mode-beatgrid-eq").click();
    const eqCard = page.getByTestId("mix-mode-beatgrid-eq-card");
    await expect(eqCard.getByTestId("mix-bars-16")).toBeVisible();
    await expect(eqCard.getByTestId("mix-section-aware")).toBeVisible();

    // Loop + EQ reuses them too.
    await page.getByTestId("mix-mode-loop-eq").click();
    const loopCard = page.getByTestId("mix-mode-loop-eq-card");
    await expect(loopCard.getByTestId("mix-bars-16")).toBeVisible();
    await expect(loopCard.getByTestId("mix-section-aware")).toBeVisible();
  });

  test("crossfade overlay honors the selected Rekordbox waveform style", async ({
    page,
  }) => {
    // Seed the RGB waveform style before the app boots (browser store).
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "starlib_ui",
        JSON.stringify({ waveformStyle: "rekordbox_rgb" }),
      );
    });
    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    // During the fade the overlay renders the Rekordbox RGB waveform, not the
    // default one.
    const overview = player.getByTestId("player-crossfade-overview");
    await expect(overview).toBeVisible({ timeout: 15000 });
    await expect(overview).toHaveAttribute("data-style", "rekordbox_color");
  });

  test("pause during the transition freezes the whole fade", async ({
    page,
  }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // Pause mid-fade: both decks and the fade clock must freeze. If only deck A
    // paused (the old bug), the fade would complete on wall-clock and advance
    // the queue to "Baz" while paused.
    await player.getByTestId("player-toggle").click();
    // Wait past the whole 6s fade window.
    await page.waitForTimeout(8000);
    await expect(player).toHaveAttribute("data-mix-state", "transitioning");
    await expect(player.getByTestId("player-next-chip")).toBeVisible();
    await expect(player.getByText("Foo", { exact: true })).toBeVisible();

    // Resume: the fade picks up where it left off and finishes into "Baz".
    await player.getByTestId("player-toggle").click();
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 15000 },
    );
  });

  test("clicking back in the overview mid-fade rescues the old track", async ({
    page,
  }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // Click near the start of the overview before the swipe: the fade aborts,
    // the old track jumps back and keeps playing.
    await player
      .getByTestId("player-crossfade-overview")
      .click({ position: { x: 20, y: 10 } });
    await expect(player).not.toHaveAttribute("data-mix-state", "transitioning");
    await expect(player.getByTitle("Foo", { exact: true })).toBeVisible();

    // The mix re-arms: the old track reaches the mix-out point again and the
    // crossfade completes into the next track on the second pass.
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 25000,
    });
  });

  test("seeking deep into the fade window joins the crossfade mid-flight", async ({
    page,
  }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // Seek to ~80% of the overview (~8s, 4s past the 4s mix-out point). The
    // restarted fade must join mid-flight: deck B cues ~4s into its own track,
    // not at its mix point (0s), so its playhead sits ≳40% — never at 0.
    const overview = player.getByTestId("player-crossfade-overview");
    const box = await overview.boundingBox();
    await overview.click({
      position: { x: Math.floor(box!.width * 0.8), y: 10 },
    });
    await expect(
      player.getByTestId("player-overview-playhead-new"),
    ).toHaveAttribute("style", /left: [4-9][0-9](\.[0-9]+)?%/, {
      timeout: 10000,
    });
    // The shortened remainder of the fade completes into "Baz".
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 15000 },
    );
  });

  test("post-swipe clicks re-time the fade or finish it past the window", async ({
    page,
  }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    // Wait for the swipe to settle: the incoming layer at identity transform.
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    const newLayer = player
      .getByTestId("player-overview-swipe")
      .locator(":scope > div")
      .nth(1);
    await expect(newLayer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)", {
      timeout: 15000,
    });

    // Click at 30% of the incoming track (~3s) — inside the 6s fade window.
    // The whole fade re-times: deck A must move to the matching position
    // (mix-out 4s + 3s elapsed = 7s → its playhead near 70%), not stay put.
    const overview = player.getByTestId("player-crossfade-overview");
    const box = await overview.boundingBox();
    await overview.click({
      position: { x: Math.floor(box!.width * 0.3), y: 10 },
    });
    await expect(
      player.getByTestId("player-overview-playhead-old"),
    ).toHaveAttribute("style", /left: (6[8-9]|7[0-9]|8[0-5])(\.[0-9]+)?%/, {
      timeout: 5000,
    });

    // Click at 95% (~9.5s) — past the fade window. The old track must not
    // play out: the fade finishes immediately and deck B is adopted there.
    await overview.click({
      position: { x: Math.floor(box!.width * 0.95), y: 10 },
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 5000 },
    );
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible();
  });

  test("no crossfade when auto-mix is off (control)", async ({ page }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");
    // Auto-mix defaults off — the state never enters transitioning while Foo
    // plays through the first few seconds.
    await page.waitForTimeout(3000);
    await expect(player).toHaveAttribute("data-mix-state", "idle");
  });

  test("time, BPM and key swap to the incoming track at the swipe", async ({
    page,
  }) => {
    // Give Baz a distinct BPM, key, and length so the rail readouts visibly
    // swap from Foo's (124 / 8A / 0:10) to Baz's.
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks",
      jsonRoute({ tracks: [TRACK_A, { ...TRACK_B, bpm: 128, key: "9A" }] }),
    );
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(route.request().url().includes("baz") ? 20 : 10),
      }),
    );

    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    // Baseline before any fade: the rail reads the current track (Foo).
    await expect(player.getByTestId("bpm-pitcher-trigger")).toContainText(
      "124",
    );
    await expect(player.getByTestId("player-key")).toContainText("8A");
    await expect(player.getByTestId("player-time")).toContainText("0:10");

    // Enable auto-mix (time crossfade — the default mode).
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    // Wait for the swipe (the rail title flips to the incoming track mid-fade),
    // then freeze the fade so the queue can't advance — this proves the
    // readouts swap AT THE SWIPE, not only after adoption.
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await player.getByTestId("player-toggle").click();
    await expect(player).toHaveAttribute("data-mix-state", "transitioning");

    // Still transitioning (queue not advanced), yet the rail already reads Baz.
    await expect(player.getByTestId("bpm-pitcher-trigger")).toContainText(
      "128",
    );
    await expect(player.getByTestId("player-key")).toContainText("9A");
    await expect(player.getByTestId("player-time")).toContainText("0:20");
  });

  test("beatgrid transition with the pitcher off leaves the pitcher off", async ({
    page,
  }) => {
    // Regression: a beatgrid (beat-sync off) transition used to ramp the
    // incoming deck to the pitcher's target BPM and force the pitcher on at
    // adoption — so track B ended up pitched with beat-sync silently enabled.
    // It must instead ramp to the incoming track's own tempo and never touch
    // the pitcher.
    const grid = denseGrid(250, 12000, "verse"); // downbeat every 1s → 12 bars
    await page.route("**/api/rekordbox/tracks/*/analysis*", jsonRoute(grid));
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(12),
      }),
    );

    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    // Baseline: the pitcher is off (no pitch rate badge on the trigger).
    await expect(player.getByTestId("bpm-pitcher-rate-badge")).toHaveCount(0);

    // Beatgrid mode, small overlap so the mix-out lands a few seconds in.
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.getByTestId("mix-mode-beatgrid").click();
    await page.getByTestId("mix-bars-8").click();
    await page.keyboard.press("Escape");

    // The bar-aligned fade fires (not a crossfade fallback) and adopts "Baz".
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 15000 },
    );

    // The pitcher was never auto-enabled: still no rate badge, and the toggle
    // reads off.
    await expect(player.getByTestId("bpm-pitcher-rate-badge")).toHaveCount(0);
    await player.getByTestId("bpm-pitcher-trigger").click();
    await expect(page.getByTestId("bpm-pitcher-toggle")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("beatgrid + EQ runs the bar-aligned bass-swap fade and adopts", async ({
    page,
  }) => {
    // Needs several downbeats for the bar-aligned strategy (and the EQ swap) to
    // engage instead of falling back to a plain crossfade.
    const grid = denseGrid(250, 12000, "verse"); // downbeat every 1s → 12 bars
    await page.route("**/api/rekordbox/tracks/*/analysis*", jsonRoute(grid));
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(12),
      }),
    );

    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.getByTestId("mix-mode-beatgrid-eq").click();
    await page.getByTestId("mix-bars-8").click();
    await page.keyboard.press("Escape");

    // The bass-swap fade fires (not a crossfade fallback) and adopts "Baz"
    // without the engine's EQ automation stalling the transition.
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 15000 },
    );
  });

  /**
   * Route setup + mode selection for the loop-eq specs. Dense grid so the
   * bar-aligned strategy engages; the section ends early (10s) so the mix-out
   * point is a couple bars in (2s with 8 bars), but the track is long (24s) so
   * deck B has content for the full 2×overlap window. Timeline: mix-out 2s,
   * loop 2–6s, Phase 1 ends 10s in (the swipe), adoption 18s in.
   */
  async function startLoopEq(page: Page) {
    const beatgrid = [];
    for (let t = 0, beat = 1; t <= 24000; t += 250, beat = (beat % 4) + 1) {
      beatgrid.push({ beat, bpm: 124, timeMs: t });
    }
    const grid = {
      beatgrid,
      sections: [{ kind: "verse", label: "verse", startMs: 0, endMs: 10000 }],
      cues: [],
    };
    await page.route("**/api/rekordbox/tracks/*/analysis*", jsonRoute(grid));
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(24),
      }),
    );

    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    // Configure the mode/bars BEFORE enabling: with 16 bars (the default) the
    // mix-out point sits at 0s, so enabling first fires the transition before
    // the remaining clicks apply.
    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-mode-loop-eq").click();
    await page.getByTestId("mix-bars-8").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");
    return player;
  }

  test("loop + EQ loops deck A, blends deck B in over two phases, and adopts", async ({
    page,
  }) => {
    const player = await startLoopEq(page);

    // The two-phase loop-eq transition fires and its overview shows the loop
    // region highlight (proof the loop-eq overlay branch rendered, not the
    // crossfade swipe).
    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    await expect(
      player.getByTestId("player-overview-loop-region"),
    ).toBeVisible();

    // Deck B ("Baz") is adopted at the end of Phase 2 (the outro fade) without
    // the loop/EQ automation stalling the transition.
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 15000 },
    );
  });

  test("loop + EQ: post-swipe clicks skip into the incoming track", async ({
    page,
  }) => {
    const player = await startLoopEq(page);

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // Wait for the swipe (Phase 1's end): the incoming layer settles at
    // identity — the view is now track B at its true scale.
    const newLayer = player
      .getByTestId("player-overview-swipe")
      .locator(":scope > div")
      .nth(1);
    await expect(newLayer).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)", {
      timeout: 20000,
    });

    // Click deep into the incoming track's body (past the transition window):
    // the fade must finish there and adopt deck B — NOT rescue back into the
    // old track (the old behavior treated every loop-eq click as a rescue).
    const overview = player.getByTestId("player-crossfade-overview");
    const box = await overview.boundingBox();
    await overview.click({
      position: { x: Math.floor(box!.width * 0.95), y: 10 },
    });
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(player).not.toHaveAttribute(
      "data-mix-state",
      "transitioning",
      { timeout: 5000 },
    );
  });

  test("loop + EQ: seeking into the transition window rejoins mid-flight", async ({
    page,
  }) => {
    const player = await startLoopEq(page);

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    // Pre-swipe click at 50% of the old track (~12s, 10s past the 2s mix-out):
    // a rescue + seek, after which the re-armed transition must JOIN at that
    // point — deck B cues ~10s into its own track (~42% of 24s), never back at
    // its mix-in (the old behavior restarted the whole schedule from the top
    // with deck B at 0 and deck A stranded outside its loop).
    const overview = player.getByTestId("player-crossfade-overview");
    const box = await overview.boundingBox();
    await overview.click({
      position: { x: Math.floor(box!.width * 0.5), y: 10 },
    });
    await expect(
      player.getByTestId("player-overview-playhead-new"),
    ).toHaveAttribute("style", /left: (4[0-9]|5[0-9])(\.[0-9]+)?%/, {
      timeout: 6000,
    });
    // The join lands past Phase 1, so the remainder completes into "Baz".
    await expect(player.getByTitle("Baz", { exact: true })).toBeVisible({
      timeout: 15000,
    });
  });

  test("cue markers stay visible in the crossfade overlay", async ({
    page,
  }) => {
    // Both tracks carry a hot cue and a memory cue; the overlay must render
    // them inside each deck's layer (regression: the opaque overlay hid the
    // base overview's markers for the whole fade).
    await page.route(
      "**/api/rekordbox/tracks/*/analysis*",
      jsonRoute({
        ...ANALYSIS,
        cues: [
          { type: "hot", index: 1, timeMs: 1000, outMs: null },
          { type: "memory", index: null, timeMs: 2000, outMs: null },
        ],
      }),
    );

    await playFirst(page);
    const player = page.getByTestId("waveform-player");

    await player.getByTestId("mix-controls-trigger").click();
    await page.getByTestId("mix-enabled-toggle").click();
    await page.keyboard.press("Escape");

    await expect(player).toHaveAttribute("data-mix-state", "transitioning", {
      timeout: 15000,
    });
    const markers = player
      .getByTestId("player-crossfade-overview")
      .getByTestId("player-overview-cue");
    // Old layer + incoming layer each carry both cues.
    await expect(markers).toHaveCount(4);
    // The wrapper is a zero-width anchor; the labelled pip is the visible bit.
    await expect(markers.first().locator("span")).toBeVisible();
  });
});
