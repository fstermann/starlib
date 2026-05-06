import { expect, test } from "./fixtures";

/**
 * Bugfix: when the audio output device disconnects (headphones unplugged,
 * Bluetooth speaker leaves the room), the OS pauses the underlying
 * <audio> element but our React `isPlaying` state stays true — the UI shows
 * "playing" with no sound. The fix listens for the audio element's `pause`
 * event and propagates it to the player context when it wasn't us who
 * initiated it.
 */

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

    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await page.locator('[data-file-path="track.mp3"]').click();

    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();

    // Click the toggle to start playback so isPlaying flips to true. (In
    // headless tests the audio element may not actually emit sound, but the
    // React state — which our pause handler reads via isPlayingRef — does.)
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
});
