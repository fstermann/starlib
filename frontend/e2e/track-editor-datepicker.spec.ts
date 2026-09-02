import { expect, test } from "./fixtures";

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "Some Artist - Some Title.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
};

const MOCK_TRACK_INFO = {
  file_path: "track.mp3",
  file_name: "Some Artist - Some Title.mp3",
  title: null,
  artist: null,
  bpm: null,
  key: null,
  genre: null,
  release_date: null,
  release_year: null,
  original_artist: null,
  remixer: null,
  mix_name: null,
  user_comment: null,
  starlib_meta: null,
  has_artwork: false,
  is_ready: false,
  missing_fields: [],
  issues: [],
};

/** Mock the metadata endpoints and open the editor for the single track. */
async function setupEditor(
  page: import("@playwright/test").Page,
  trackInfo: object = MOCK_TRACK_INFO,
) {
  const listBody = JSON.stringify({
    items: [MOCK_FILE],
    total: 1,
    page: 1,
    size: 50,
    pages: 1,
  });
  await page.route("**/api/metadata/folders/*/browse*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listBody,
    }),
  );
  await page.route(/\/api\/metadata\/folders\/browse-path\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listBody,
    }),
  );
  await page.route("**/api/metadata/files/*/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(trackInfo),
    }),
  );
  await page.route("**/api/metadata/files/*/peaks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ peaks: Array(200).fill(0.3) }),
    }),
  );
  await page.route("**/api/suggestions/track", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ fields: {} }),
    }),
  );

  await page.goto("/library");
  await page.waitForLoadState("networkidle");
  await page.locator('[data-file-path="track.mp3"]').click();
  await expect(page.locator('input[placeholder="Title"]')).toBeVisible();
}

test.describe("Track editor — release-date picker", () => {
  // Pin the clock so the calendar opens on a known month (its default is today).
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date("2025-06-15T12:00:00") });
  });

  test("picking a day from the calendar fills the release date", async ({
    page,
  }) => {
    await setupEditor(page);

    // Empty state renders the "Pick date" trigger.
    const trigger = page.getByRole("button", { name: "Pick date" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // The calendar renders (react-day-picker v10) on the pinned month.
    const calendar = page.locator('[data-slot="calendar"]');
    await expect(calendar).toBeVisible();
    await expect(calendar.getByText("June 2025")).toBeVisible();

    // Select June 20 and assert the trigger reflects the picked date.
    await calendar.getByText("20", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "20.06.2025" }),
    ).toBeVisible();
  });

  test("renders an existing release date and lets you re-pick it", async ({
    page,
  }) => {
    await setupEditor(page, { ...MOCK_TRACK_INFO, release_date: "2024-03-10" });

    // The stored date is formatted onto the trigger.
    const trigger = page.getByRole("button", { name: "10.03.2024" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Re-pick a different day; the trigger updates to the new value.
    const calendar = page.locator('[data-slot="calendar"]');
    await expect(calendar).toBeVisible();
    await calendar.getByText("20", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "20.06.2025" }),
    ).toBeVisible();
  });
});
