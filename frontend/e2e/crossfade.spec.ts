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
});
