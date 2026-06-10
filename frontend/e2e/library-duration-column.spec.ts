import { expect, test } from "./fixtures";

const FILE_A = {
  file_path: "alpha.flac",
  file_name: "alpha.flac",
  file_size: 20 * 1024 * 1024,
  file_format: ".flac",
  has_artwork: false,
  title: "Alpha",
  artist: "Alpha",
  duration: 245,
};

const FILE_B = {
  file_path: "bravo.mp3",
  file_name: "bravo.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
  title: "Bravo",
  artist: "Bravo",
  duration: 65,
};

test.describe("Library Duration column", () => {
  test.beforeEach(async ({ page }) => {
    const handleBrowse = (route: import("@playwright/test").Route) => {
      const url = new URL(route.request().url());
      const sortBy = url.searchParams.get("sort_by");
      const sortOrder = url.searchParams.get("sort_order") ?? "asc";
      let items = [FILE_A, FILE_B];
      if (sortBy === "duration") {
        items = [...items].sort((a, b) => a.duration - b.duration);
        if (sortOrder === "desc") items.reverse();
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items,
          total: items.length,
          page: 1,
          size: 50,
          pages: 1,
        }),
      });
    };
    await page.route("**/api/metadata/folders/*/browse*", handleBrowse);
    await page.route(/\/api\/metadata\/folders\/browse-path\?/, handleBrowse);

    await page.route(/filter-values/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          genres: [],
          genre_counts: {},
          artists: [],
          keys: [],
          key_counts: {},
          bpm_min: null,
          bpm_max: null,
          file_formats: ["flac", "mp3"],
          file_format_counts: { flac: 1, mp3: 1 },
          file_size_min: 0,
          file_size_max: 0,
        }),
      }),
    );
  });

  test("renders M:SS values and sorts by duration", async ({ page }) => {
    await page.goto("/library");
    await expect(page.locator("[data-index]")).toHaveCount(2);

    const header = page.getByRole("row").first();
    await expect(header.getByText("Duration", { exact: true })).toBeVisible();

    const cells = page.locator("[data-duration-cell]");
    await expect(cells).toHaveCount(2);
    // Default sort is mtime desc → server returns insertion order.
    await expect(
      page.locator('[data-index="0"] [data-duration-cell]'),
    ).toHaveText("4:05");
    await expect(
      page.locator('[data-index="1"] [data-duration-cell]'),
    ).toHaveText("1:05");

    // Click Duration header → ascending by duration → bravo (1:05) first.
    const sortRequest = page.waitForRequest((req) =>
      req.url().includes("sort_by=duration"),
    );
    await header.locator("button", { hasText: "Duration" }).click();
    await sortRequest;

    await expect(
      page.locator('[data-index="0"] [data-duration-cell]'),
    ).toHaveText("1:05");
    await expect(
      page.locator('[data-index="1"] [data-duration-cell]'),
    ).toHaveText("4:05");

    // Toggle to descending → alpha first.
    await header.locator("button", { hasText: "Duration" }).click();
    await expect(
      page.locator('[data-index="0"] [data-duration-cell]'),
    ).toHaveText("4:05");
  });
});
