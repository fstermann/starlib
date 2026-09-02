import { expect, test } from "./fixtures";

/**
 * Click-to-expand artwork: the player rail's small artwork button morphs into
 * a tree-panel-sized preview above the player; clicking the preview collapses
 * it back.
 */

/** Minimal 100ms silent WAV (8kHz mono 8-bit PCM). */
function makeSilentWav(): Buffer {
  const rate = 8000;
  const numSamples = 800;
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

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: true,
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
  has_artwork: true,
  is_ready: false,
  missing_fields: [],
  issues: [],
};

test("artwork expands to a large preview and collapses on click", async ({
  page,
}) => {
  await page.route("**/api/metadata/folders/*/browse*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [MOCK_FILE],
        total: 1,
        page: 1,
        size: 50,
        pages: 1,
      }),
    }),
  );
  await page.route(/\/api\/metadata\/folders\/browse-path\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [MOCK_FILE],
        total: 1,
        page: 1,
        size: 50,
        pages: 1,
      }),
    }),
  );
  await page.route("**/api/metadata/files/*/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_TRACK_INFO),
    }),
  );
  await page.route("**/api/metadata/files/*/peaks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ peaks: Array(200).fill(0.3) }),
    }),
  );
  await page.route("**/api/metadata/files/*/audio", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      headers: { "Accept-Ranges": "bytes" },
      body: makeSilentWav(),
    }),
  );
  await page.route("**/api/metadata/files/*/artwork*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG,
    }),
  );

  await page.goto("/library");
  await page.waitForLoadState("networkidle");
  await page.locator('[data-file-path="track.mp3"]').click();

  const player = page.getByTestId("waveform-player");
  await expect(player).toBeVisible();

  // Small rail artwork: a button, collapsed.
  const artwork = page.getByTestId("player-artwork");
  await expect(artwork).toBeVisible();
  await expect(artwork).toHaveAttribute("aria-expanded", "false");
  await expect(artwork).toHaveAttribute("title", "Expand artwork");

  // Click → the tree-panel-sized preview replaces it (same testid, expanded).
  await artwork.click();
  const preview = page.getByTestId("player-artwork");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("aria-expanded", "true");
  await expect(preview).toHaveAttribute("title", "Collapse artwork");
  // Tree-panel sized (default 240px) — far larger than the 36px thumbnail.
  await expect
    .poll(async () => (await preview.boundingBox())?.width ?? 0)
    .toBeGreaterThan(150);

  // Click the preview → collapses back to the small rail artwork.
  await preview.click();
  const collapsed = page.getByTestId("player-artwork");
  await expect(collapsed).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(async () => (await collapsed.boundingBox())?.width ?? 0)
    .toBeLessThan(60);
});
