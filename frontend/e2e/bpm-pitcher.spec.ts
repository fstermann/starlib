import { expect, test } from "./fixtures";

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
  // Browse response → fed straight into the player queue. The BPM here
  // seeds the pitcher's `currentBpm` so we can assert a deterministic rate
  // without invoking the (Tauri-only) auto-detect path.
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

test.describe("BPM pitcher", () => {
  test.beforeEach(async ({ page }) => {
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
  });

  test("shows current BPM and pitches playback to target", async ({ page }) => {
    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await page.locator('[data-file-path="track.mp3"]').click();

    await expect(page.getByTestId("waveform-player")).toBeVisible();

    // Trigger button always shows the current BPM seeded from the queue.
    const trigger = page.getByTestId("bpm-pitcher-trigger");
    await expect(trigger).toContainText("120");

    // Open popover and verify the readout starts at 1.000× (pitch off).
    await trigger.click();
    const popover = page.getByTestId("bpm-pitcher-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("bpm-pitcher-current")).toContainText(
      "120 BPM",
    );
    await expect(page.getByTestId("bpm-pitcher-rate-readout")).toContainText(
      "1.000×",
    );

    // Set a target of 130 BPM and commit.
    const input = page.getByTestId("bpm-pitcher-target-input");
    await input.fill("130");
    await input.press("Enter");

    // Toggle pitch on.
    await page.getByTestId("bpm-pitcher-toggle").click();

    // 130 / 120 = 1.0833…
    await expect(page.getByTestId("bpm-pitcher-rate-readout")).toContainText(
      "1.083×",
    );
    await expect(page.getByTestId("bpm-pitcher-rate-readout")).toContainText(
      "+8.3%",
    );

    // The trigger badge mirrors the +8.3% indicator when pitching is on.
    await expect(page.getByTestId("bpm-pitcher-rate-badge")).toContainText(
      "+8.3%",
    );

    // Toggle pitch off → rate returns to 1.000×, trigger badge disappears.
    await page.getByTestId("bpm-pitcher-toggle").click();
    await expect(page.getByTestId("bpm-pitcher-rate-readout")).toContainText(
      "1.000×",
    );
    await expect(page.getByTestId("bpm-pitcher-rate-badge")).not.toBeVisible();
  });

  test("persists target BPM and pitch state across reloads", async ({
    page,
  }) => {
    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await page.locator('[data-file-path="track.mp3"]').click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();

    await page.getByTestId("bpm-pitcher-trigger").click();
    const input = page.getByTestId("bpm-pitcher-target-input");
    await input.fill("128");
    await input.press("Enter");
    await page.getByTestId("bpm-pitcher-toggle").click();

    // Round-trip via reload — Pitch persists to localStorage.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-file-path="track.mp3"]').click();
    await expect(page.getByTestId("waveform-player")).toBeVisible();

    // 128 / 120 = 1.0666… → "1.067×"
    await page.getByTestId("bpm-pitcher-trigger").click();
    await expect(page.getByTestId("bpm-pitcher-rate-readout")).toContainText(
      "1.067×",
    );
    await expect(page.getByTestId("bpm-pitcher-target-input")).toHaveValue(
      "128",
    );
  });
});
