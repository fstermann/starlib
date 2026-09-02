import type { Page, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

/** ~3s silent WAV (8kHz mono 8-bit PCM) so audio.duration resolves and the
 * track doesn't end mid-test (which would race isPlaying-dependent flows). */
function makeSilentWav(): Buffer {
  const numSamples = 24000;
  const buf = Buffer.alloc(44 + numSamples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
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

const REK_TRACK = {
  id: "t-1",
  title: "Foo",
  artist: "Bar",
  album: null,
  genre: "House",
  bpm: 124.5,
  key: "8A",
  duration_seconds: 350,
  file_path: "/music/foo.flac",
  comment: null,
  soundcloud_id: null,
  date_added: "2024-01-15",
  release_date: null,
  has_artwork: true,
  has_waveform: true,
};

const PLAYLISTS = [
  {
    id: "pl-1",
    name: "Sunday Mix",
    parent_id: null,
    is_folder: false,
    is_smart: false,
    track_count: 1,
  },
];

const ANALYSIS = {
  beatgrid: [
    { beat: 1, bpm: 124.5, timeMs: 0 },
    { beat: 2, bpm: 124.5, timeMs: 482 },
    { beat: 3, bpm: 124.5, timeMs: 964 },
    { beat: 4, bpm: 124.5, timeMs: 1446 },
  ],
  sections: [{ kind: "intro", label: "Intro", startMs: 0, endMs: 1446 }],
  cues: [
    // Slot-A hot cue is a loop (has an out-point) → clicking re-arms the loop.
    {
      type: "hot",
      index: 1,
      timeMs: 0,
      color: "#ff8800",
      comment: null,
      outMs: 2000,
    },
    { type: "memory", index: null, timeMs: 50, color: null, comment: null },
  ],
};

test.describe("Player zoom — Rekordbox track", () => {
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
      jsonRoute({ tracks: [REK_TRACK] }),
    );
    await page.route("**/api/rekordbox/tracks/*/artwork*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: TINY_JPEG,
      }),
    );
    // Preview + detail waveform bytes (any content; the canvas just paints).
    await page.route("**/api/rekordbox/tracks/*/waveform*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: Buffer.alloc(7200),
      }),
    );
    await page.route(
      "**/api/rekordbox/tracks/*/analysis*",
      jsonRoute(ANALYSIS),
    );
    await page.route(
      "**/api/metadata/files/*/peaks*",
      jsonRoute({ peaks: Array(200).fill(0.3) }),
    );
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: makeSilentWav(),
      }),
    );
  });

  async function playFoo(page: Page) {
    await page.goto("/library?source=rekordbox");
    await page.getByText("Sunday Mix").click();
    const tracks = page.getByTestId("rekordbox-tracks");
    await tracks.getByRole("button", { name: "Play Foo" }).click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();
  }

  test("shows the analysed key in the player", async ({ page }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");
    // Musical key from the Rekordbox analysis, shown next to the BPM.
    await expect(player.getByText("8A", { exact: true })).toBeVisible();
    // Phrase sections are marked on the whole-track overview, not the zoom strip.
    await expect(player.getByTestId("player-section").first()).toBeVisible();
  });

  test("shows the pitched key, with the original + fractional shift below", async ({
    page,
  }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");
    await expect(player.getByText("8A", { exact: true })).toBeVisible();

    // Pitch 124.5 → 140 BPM: nearest whole semitone is +2 (8A → 10A), but the
    // exact shift is fractional (+2.0 st).
    await player.getByTestId("bpm-pitcher-trigger").click();
    const input = page.getByTestId("bpm-pitcher-target-input");
    await input.fill("140");
    await input.press("Enter");
    await page.getByTestId("bpm-pitcher-toggle").click();
    await page.keyboard.press("Escape");

    // Big label = pitched key, green.
    const key = player.getByText("10A", { exact: true });
    await expect(key).toBeVisible();
    await expect(key).toHaveClass(/text-primary/);
    // Below = original key + fractional semitone shift.
    await expect(player.getByText("8A +2.0 st", { exact: true })).toBeVisible();
  });

  test("overview shows numbered, clickable cue markers", async ({ page }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");

    // Hot cues render colour-coded with their letter (slot 1 → "A"); memory
    // cues are numbered from 1. Each is clickable to seek.
    const cues = player.getByTestId("player-cue");
    await expect(cues).toHaveCount(2);
    await expect(cues.filter({ hasText: "A" })).toHaveAttribute(
      "data-cue-type",
      "hot",
    );
    await expect(cues.filter({ hasText: "1" })).toHaveAttribute(
      "data-cue-type",
      "memory",
    );
    await cues.first().click();
  });

  test("CUE sets and recalls an in-memory cue point", async ({ page }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");

    // No cue point yet.
    await expect(page.getByTestId("player-cue-point")).toHaveCount(0);

    // Pause (wait for it to register so CUE takes the "set" branch, not
    // "recall"), then CUE sets a cue point marker on the overview.
    await player.getByTestId("player-toggle").click();
    await expect(player.getByRole("button", { name: "Play" })).toBeVisible();
    await player.getByTestId("player-cue-btn").click();
    await expect(page.getByTestId("player-cue-point")).toBeVisible();
  });

  test("loop control lives in the top bar and toggles an active loop", async ({
    page,
  }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");

    // The merged loop control sits in the always-visible top utility bar — no
    // need to zoom in first. Idle to start (no region drawn).
    const loopBtn = player.getByTestId("player-loop-btn");
    await expect(loopBtn).toBeVisible();
    await expect(page.getByTestId("player-loop-region")).toHaveCount(0);

    // Toggle → active loop draws a region on the overview.
    await loopBtn.click();
    await expect(loopBtn).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("player-loop-region")).toBeVisible();
  });

  test("top bar shows pressable hot cues", async ({ page }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");

    // Both analysed cues (one hot, one memory) surface as pressable chips.
    const hotcues = player.getByTestId("player-hotcue");
    await expect(hotcues).toHaveCount(2);
    await expect(hotcues.first()).toHaveAttribute("data-cue-type", "hot");
    // Pressing one seeks — just assert it doesn't throw / stays mounted.
    await hotcues.first().click();
    await expect(player).toBeVisible();
  });

  test("loop hot cue re-arms its loop when clicked", async ({ page }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");

    // No loop yet. The slot-A hot cue carries an out-point (it's a loop).
    await expect(page.getByTestId("player-loop-region")).toHaveCount(0);
    await player
      .getByTestId("player-hotcue")
      .filter({ hasText: "A" })
      .first()
      .click();
    // Clicking it arms the loop region on the overview.
    await expect(page.getByTestId("player-loop-region")).toBeVisible();
  });

  test("overview shows a play-position indicator", async ({ page }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");
    await expect(player.getByTestId("player-overview-playhead")).toBeVisible();
  });

  test("detail toggle shows/hides the strip; +/- change the zoom level", async ({
    page,
  }) => {
    await playFoo(page);
    const player = page.getByTestId("waveform-player");

    // Overview only to start — no detail strip; the zoom stepper is hidden.
    await expect(page.getByTestId("player-detail-strip")).toHaveCount(0);
    await expect(player.getByRole("button", { name: "Zoom in" })).toHaveCount(
      0,
    );

    // The dedicated toggle reveals the strip (and the zoom stepper) at the
    // default zoom.
    await player.getByTestId("player-detail-toggle").click();
    const strip = page.getByTestId("player-detail-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-zoom-bars", "32");
    await expect(strip.locator("canvas")).toBeVisible();

    // +/- only change the zoom level — they never hide the strip.
    await player.getByRole("button", { name: "Zoom in" }).click();
    await expect(strip).toHaveAttribute("data-zoom-bars", "16");
    await player.getByRole("button", { name: "Zoom out" }).click();
    await expect(strip).toHaveAttribute("data-zoom-bars", "32");

    // The toggle hides both the strip and the stepper again.
    await player.getByTestId("player-detail-toggle").click();
    await expect(page.getByTestId("player-detail-strip")).toHaveCount(0);
    await expect(player.getByRole("button", { name: "Zoom in" })).toHaveCount(
      0,
    );
  });
});

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
};

const MOCK_TRACK_INFO = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  title: "Test Track",
  artist: "Test Artist",
  bpm: null,
  key: null,
  genre: null,
  comment: null,
  release_date: null,
  remixers: [],
  has_artwork: false,
  is_ready: false,
  missing_fields: [],
  issues: [],
};

test.describe("Player zoom — local file", () => {
  test.beforeEach(async ({ page }) => {
    const browse = jsonRoute({
      items: [MOCK_FILE],
      total: 1,
      page: 1,
      size: 50,
      pages: 1,
    });
    await page.route("**/api/metadata/folders/*/browse*", browse);
    await page.route(/\/api\/metadata\/folders\/browse-path\?/, browse);
    await page.route(
      "**/api/metadata/files/*/info",
      jsonRoute(MOCK_TRACK_INFO),
    );
    await page.route(
      "**/api/metadata/files/*/peaks*",
      jsonRoute({ peaks: Array(200).fill(0.3) }),
    );
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes" },
        body: makeSilentWav(),
      }),
    );
  });

  test("local files are zoomable (no beatgrid, still expands)", async ({
    page,
  }) => {
    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await page.locator('[data-file-path="track.mp3"]').click();
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    await player.getByTestId("player-detail-toggle").click();
    await expect(page.getByTestId("player-detail-strip")).toBeVisible();
  });
});
