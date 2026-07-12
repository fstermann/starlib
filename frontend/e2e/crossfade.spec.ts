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

test.describe("Auto-mix crossfade", () => {
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
    await page.route(
      "**/api/rekordbox/tracks/*/analysis*",
      jsonRoute(ANALYSIS),
    );
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

    // Enable auto-mix (simple time crossfade — the default mode).
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
    // The zoom detail strip splits into two stacked scrolling decks (incoming
    // on top, out-going on bottom) during the fade.
    await expect(player.getByTestId("player-detail-split")).toBeVisible();
    await expect(player.getByText("Baz", { exact: true })).toBeVisible({
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

  test("no crossfade when auto-mix is off (control)", async ({ page }) => {
    await playFirst(page);
    const player = page.getByTestId("waveform-player");
    // Auto-mix defaults off — the state never enters transitioning while Foo
    // plays through the first few seconds.
    await page.waitForTimeout(3000);
    await expect(player).toHaveAttribute("data-mix-state", "idle");
  });
});
