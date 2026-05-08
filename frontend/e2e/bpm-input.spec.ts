import { expect, test } from "./fixtures";

// #370: BPM widget replaces native up/down arrows with explicit -/+ buttons
// (react-aria NumberField). Direct numeric typing still works.
test.describe("BPM number input", () => {
  test("clicking the increment button bumps the value by one", async ({
    page,
  }) => {
    const filePath = "/music/test - track.mp3";

    const browseBody = {
      items: [
        {
          file_path: filePath,
          file_name: "test - track.mp3",
          file_size: 1000,
          file_format: "mp3",
          has_artwork: false,
          title: "track",
          artist: "test",
          bpm: 120,
          key: null,
          genre: null,
          comment: null,
          release_date: null,
          remixers: null,
          soundcloud_id: null,
          duration: 200,
          mtime: Date.now() / 1000,
        },
      ],
      total: 1,
      page: 1,
      size: 50,
      pages: 1,
    };

    await page.route("**/api/metadata/folders/*/browse*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(browseBody),
      }),
    );
    await page.route(/\/api\/metadata\/folders\/browse-path\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(browseBody),
      }),
    );
    await page.route(/\/api\/metadata\/files\/.+\/info/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          file_path: filePath,
          file_name: "test - track.mp3",
          title: "track",
          artist: "test",
          bpm: 120,
          key: null,
          genre: null,
          comment: null,
          release_date: null,
          remixers: null,
          has_artwork: false,
          is_ready: true,
          missing_fields: [],
          issues: [],
        }),
      }),
    );

    await page.goto("/library");
    await page.waitForLoadState("networkidle");

    const dataRow = page.locator('[data-index="0"]');
    await dataRow.waitFor({ state: "visible" });
    await dataRow.locator("[data-file-path]").first().click();
    await page
      .locator('input[data-slot="input"][placeholder="Title"]')
      .waitFor({ state: "visible" });

    const bpm = page.locator('[data-testid="bpm-input"]');
    await expect(bpm).toBeVisible();
    await expect(bpm).toHaveValue("120");

    const incrementBtn = page.getByRole("button", { name: "Increase BPM" });
    await incrementBtn.click();
    await expect(bpm).toHaveValue("121");
    await incrementBtn.click();
    await expect(bpm).toHaveValue("122");
  });
});
