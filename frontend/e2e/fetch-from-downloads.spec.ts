import { expect, test } from "./fixtures";

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "track.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
};

async function setupBrowse(page: import("@playwright/test").Page) {
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
}

test.describe("Fetch from Downloads", () => {
  test("opens dialog, posts request with selected window, shows summary", async ({
    page,
  }) => {
    await setupBrowse(page);

    let postedBody: { dest_path: string; window_days: number } | null = null;
    await page.route(
      "**/api/metadata/folders/fetch-from-downloads",
      (route) => {
        postedBody = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            moved: ["recent.mp3", "another.flac"],
            skipped: ["already-there.mp3"],
            errors: [],
          }),
        });
      },
    );

    await page.goto("/library");
    await expect(page.locator("[data-index]")).toHaveCount(1);

    await page.getByTestId("fetch-from-downloads-trigger").first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Fetch from Downloads")).toBeVisible();

    // Pick the 7-day preset.
    await dialog.getByRole("radio", { name: "7d" }).click();

    await dialog.getByTestId("fetch-confirm").click();

    await expect.poll(() => postedBody?.window_days).toBe(7);
    expect(postedBody!.dest_path).toMatch(/\/music$/);

    // Toast surfaces the summary.
    await expect(page.getByText(/Moved 2 files/)).toBeVisible();
    await expect(dialog).not.toBeVisible();
  });

  test("custom window posts the typed number of days", async ({ page }) => {
    await setupBrowse(page);

    let posted: { window_days: number } | null = null;
    await page.route(
      "**/api/metadata/folders/fetch-from-downloads",
      (route) => {
        posted = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ moved: [], skipped: [], errors: [] }),
        });
      },
    );

    await page.goto("/library");
    await page.getByTestId("fetch-from-downloads-trigger").first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Custom" }).click();
    await dialog.getByTestId("fetch-custom-days").fill("14");
    await dialog.getByTestId("fetch-confirm").click();

    await expect.poll(() => posted?.window_days).toBe(14);
  });
});
