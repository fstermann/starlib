import { expect, test } from "./fixtures";

/**
 * The player's top utility bar (hot/memory cues + loop control) is meaningful
 * only for local/Rekordbox decks. SoundCloud tracks carry no cues or beatgrid
 * and stream through an HLS element, so the whole bar is hidden in SC view.
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

function scTrack(id: number, title: string) {
  return {
    id,
    urn: `soundcloud:tracks:${id}`,
    title,
    user: { id: 1, username: "me" },
    duration: 200_000,
    permalink_url: `https://soundcloud.com/me/${title.toLowerCase()}`,
    waveform_url: `https://wave.sndcdn.com/${id}.png`,
  };
}

test("utility bar is shown for a local track", async ({ page }) => {
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

  await page.goto("/library");
  await page.waitForLoadState("networkidle");
  await page.locator('[data-file-path="track.mp3"]').click();

  const player = page.getByTestId("waveform-player");
  await expect(player).toBeVisible();
  await expect(player.getByTestId("player-utility-bar")).toBeVisible();
});

test("utility bar is hidden in SoundCloud view", async ({ page }) => {
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
        collection: [scTrack(101, "Alpha")],
        next_href: null,
      }),
    }),
  );
  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("https://api.soundcloud.com/me/feed/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
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
  await page.route("**/api/soundcloud/tracks/*/stream*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://cdn.example.com/sc-101.wav",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }),
  );
  await page.route("https://cdn.example.com/sc-*.wav", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: makeSilentWav(),
    }),
  );
  await page.route("https://wave.sndcdn.com/*.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        width: 1800,
        height: 140,
        samples: Array.from({ length: 1800 }, () => 42),
      }),
    }),
  );

  await page.goto("/library?source=soundcloud");
  await expect(page.locator("[data-index]")).toHaveCount(1, { timeout: 5000 });

  await page
    .locator('[data-index="0"]')
    .getByRole("button", { name: /play/i })
    .first()
    .click()
    .catch(async () => {
      await page.locator('[data-index="0"]').click();
    });

  const player = page.getByTestId("waveform-player");
  await expect(player).toBeVisible();
  await expect(player).toContainText("Alpha");
  await expect(player.getByTestId("player-utility-bar")).toHaveCount(0);
});
