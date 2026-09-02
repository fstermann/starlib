import { expect, test } from "./fixtures";

/**
 * The currently-playing SoundCloud row shows its hover affordance persistently
 * — the row highlight (aria-current) and the cover's Pause overlay stay on
 * without a hovering cursor, so the playing track stays identifiable as the
 * queue auto-advances. Regression: the SC table only revealed the cover
 * overlay on hover and never marked the current row, so autoplayed tracks (the
 * cursor no longer over them) looked like nothing was playing.
 */

/** Silent mono 8-bit WAV of `seconds` at 8kHz — playback just needs to start
 * and stay playing; the content is irrelevant. */
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

function scTrack(id: number, title: string) {
  return {
    id,
    urn: `soundcloud:tracks:${id}`,
    title,
    user: { id: 1, username: "me" },
    duration: 180_000,
    permalink_url: `https://soundcloud.com/me/${title.toLowerCase()}`,
    artwork_url: null,
  };
}

async function setup(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
    window.localStorage.setItem(
      "sc_user",
      JSON.stringify({
        id: 1,
        username: "me",
        permalink: "me",
        avatar_url: null,
      }),
    );
  });

  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: [scTrack(101, "Alpha"), scTrack(102, "Beta")],
        next_href: null,
      }),
    }),
  );
  for (const url of [
    "https://api.soundcloud.com/me/reposts/tracks*",
    "https://api.soundcloud.com/me/playlists*",
  ]) {
    await page.route(url, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );
  }
  await page.route("**/api/soundcloud/system-playlists", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "unavailable" }),
    }),
  );
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bpms: {} }),
    }),
  );
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );

  // Resolve every SC stream to a short silent wav so playback starts and the
  // queue can advance offline.
  await page.route("**/api/soundcloud/tracks/*/stream*", (route) => {
    const id =
      route
        .request()
        .url()
        .match(/tracks\/(\d+)\/stream/)?.[1] ?? "0";
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: `https://cdn.example.com/sc-${id}.wav`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
  });
  await page.route("https://cdn.example.com/sc-*.wav", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: makeSilentWav(5),
    }),
  );
}

/** The cover overlay (dark scrim + play/pause icon) for the row at `index`. */
function coverOverlay(page: import("@playwright/test").Page, index: number) {
  return page
    .locator(`[data-index="${index}"]`)
    .getByRole("button", { name: /Alpha|Beta/ })
    .locator("span")
    .first();
}

function row(page: import("@playwright/test").Page, index: number) {
  return page.locator(`[data-index="${index}"] [role="row"]`).first();
}

test("current SoundCloud row keeps its hover affordance without a cursor over it", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/library?source=soundcloud");

  await expect(page.locator("[data-index]")).toHaveCount(2, { timeout: 5000 });

  // Start the first track from its cover play button.
  await page
    .locator('[data-index="0"]')
    .getByRole("button", { name: /Play Alpha/ })
    .click();

  await expect(page.getByTestId("waveform-player")).toBeVisible();
  // Move the cursor off the list so any assertion below reflects the current-
  // track state, not a hover.
  await page.mouse.move(0, 0);

  // Row 0 is the current track: marked, and its cover shows a persistent Pause.
  await expect(row(page, 0)).toHaveAttribute("aria-current", "true");
  await expect(
    page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /Pause Alpha/ }),
  ).toBeVisible();
  await expect(coverOverlay(page, 0)).toHaveCSS("opacity", "1");

  // Row 1 is not current and not hovered: overlay hidden, row unmarked.
  await expect(row(page, 1)).not.toHaveAttribute("aria-current", "true");
  await expect(coverOverlay(page, 1)).toHaveCSS("opacity", "0");

  // Auto-advance (same primitive end-of-track autoplay uses) moves the marker.
  await page.getByRole("button", { name: "Next track" }).click();
  await page.mouse.move(0, 0);

  await expect(row(page, 1)).toHaveAttribute("aria-current", "true");
  await expect(
    page
      .locator('[data-index="1"]')
      .getByRole("button", { name: /Pause Beta/ }),
  ).toBeVisible();
  await expect(coverOverlay(page, 1)).toHaveCSS("opacity", "1");

  await expect(row(page, 0)).not.toHaveAttribute("aria-current", "true");
  await expect(coverOverlay(page, 0)).toHaveCSS("opacity", "0");
});
