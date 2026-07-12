import { expect, test } from "./fixtures";

/**
 * Bugfix: when the audio output device disconnects (headphones unplugged,
 * Bluetooth speaker leaves the room), the OS pauses the underlying
 * <audio> element but our React `isPlaying` state stays true — the UI shows
 * "playing" with no sound. The fix listens for the audio element's `pause`
 * event and propagates it to the player context when it wasn't us who
 * initiated it.
 *
 * Local files now play through Web Audio (no <audio> element), so the
 * element-`pause` path is exercised via a SoundCloud (HLS) track, which still
 * uses an <audio> element. The device-count-drop path below covers both
 * backends and is checked against a local track.
 */

const SC_TRACK_ID = 42;

/** ~3s silent WAV so the local Web Audio track keeps "playing" through the
 * test instead of ending mid-way (which would confound the isPlaying state). */
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

/** Minimal SoundCloud setup: authed user + one likeable, streamable track. */
async function setupSoundcloud(page: import("@playwright/test").Page) {
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
        collection: [
          {
            id: SC_TRACK_ID,
            urn: `soundcloud:tracks:${SC_TRACK_ID}`,
            title: "Disconnect me",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/disconnect-me",
          },
        ],
        next_href: null,
      }),
    }),
  );
  for (const url of [
    "https://api.soundcloud.com/tracks*",
    "https://api.soundcloud.com/me/playlists*",
    "https://api.soundcloud.com/me/feed/tracks*",
  ]) {
    await page.route(url, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );
  }
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
  await page.route("**/api/soundcloud/tracks/*/stream*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://example.com/fake.m3u8",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }),
  );
}

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
  bpm: 120,
};

const MOCK_TRACK_INFO = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  title: "Test Track",
  artist: "Test Artist",
  bpm: 120,
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

test.describe("audio output disconnect", () => {
  test("OS-level pause on the <audio> element flips React state to paused", async ({
    page,
  }) => {
    await setupSoundcloud(page);
    await page.goto("/library?source=soundcloud");

    const row = page.locator("[data-index]").first();
    await expect(row).toContainText("Disconnect me");

    // Start playback so the player has a current SC track (HLS → <audio>).
    await row
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await row.click();
      });

    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    const toggle = page.getByTestId("player-toggle");
    if ((await toggle.getAttribute("aria-label")) !== "Pause") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-label", "Pause");

    // Wait until the <audio> element our handler is attached to actually
    // exists in the DOM (it's created inside an async init effect).
    await page.waitForFunction(() => document.querySelector("audio") !== null);

    // Simulate the OS pausing the media externally — e.g. headphones unplug.
    // Dispatching a 'pause' event mirrors what the platform does when the
    // audio output device disappears: the element is already paused, the
    // event fires, and our handler must propagate that to React state.
    await page.evaluate(() => {
      const audio = document.querySelector("audio");
      audio?.dispatchEvent(new Event("pause"));
    });

    // The handler should call player-context's pause() → isPlaying=false →
    // the toggle button flips back to "Play".
    await expect(toggle).toHaveAttribute("aria-label", "Play");
  });

  test("audiooutput count drop on devicechange flips React state to paused", async ({
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
        body: makeSilentWav(),
      }),
    );

    // Stub enumerateDevices BEFORE navigation so the player effect's initial
    // count snapshot uses our two-output baseline. The listener pauses when a
    // devicechange event fires and the count has dropped — same signal a real
    // AirPods disconnect produces in WKWebView/Chromium.
    await page.addInitScript(() => {
      const w = window as unknown as { __outputCount: number };
      w.__outputCount = 2;
      const fakeDevices = () =>
        Array.from({ length: w.__outputCount }, () => ({
          deviceId: "",
          kind: "audiooutput" as const,
          label: "",
          groupId: "",
          toJSON() {
            return {
              deviceId: "",
              kind: "audiooutput",
              label: "",
              groupId: "",
            };
          },
        }));
      navigator.mediaDevices.enumerateDevices = async () =>
        fakeDevices() as unknown as MediaDeviceInfo[];
    });

    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await page.locator('[data-file-path="track.mp3"]').click();

    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    const toggle = page.getByTestId("player-toggle");
    if ((await toggle.getAttribute("aria-label")) !== "Pause") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-label", "Pause");

    // Fire an initial devicechange while the count is still 2 — this
    // deterministically syncs the listener's baseline (its mount-time count is
    // set asynchronously and can lag under parallel load).
    await page.evaluate(() =>
      navigator.mediaDevices.dispatchEvent(new Event("devicechange")),
    );
    await page.waitForTimeout(50);

    // Now drop one output and fire again — mirrors AirPods leaving the device
    // list. The listener observes the count decrease and pauses.
    await page.evaluate(() => {
      const w = window as unknown as { __outputCount: number };
      w.__outputCount = 1;
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });

    await expect(toggle).toHaveAttribute("aria-label", "Play");
  });
});
