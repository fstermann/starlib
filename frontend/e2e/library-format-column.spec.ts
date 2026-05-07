import { expect, test } from "./fixtures";

const FILE_A = {
  file_path: "alpha.flac",
  file_name: "alpha.flac",
  file_size: 20 * 1024 * 1024,
  file_format: ".flac",
  has_artwork: false,
  title: "Alpha",
  artist: "Alpha",
};

const FILE_B = {
  file_path: "bravo.mp3",
  file_name: "bravo.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
  title: "Bravo",
  artist: "Bravo",
};

test.describe("Library Format column", () => {
  test.beforeEach(async ({ page }) => {
    const handleBrowse = (route: import("@playwright/test").Route) => {
      const url = new URL(route.request().url());
      const sortBy = url.searchParams.get("sort_by");
      const sortOrder = url.searchParams.get("sort_order") ?? "asc";
      let items = [FILE_A, FILE_B];
      if (sortBy === "file_format") {
        items = [...items].sort((a, b) =>
          a.file_format.localeCompare(b.file_format),
        );
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
  });

  test("Format column renders values and sorts by format", async ({ page }) => {
    await page.goto("/library");
    await expect(page.locator("[data-index]")).toHaveCount(2);

    const header = page.getByRole("row").first();
    await expect(header.getByText("Format", { exact: true })).toBeVisible();

    // Both rows show the format string (extension without dot).
    const cells = page.locator("[data-format-cell]");
    await expect(cells).toHaveCount(2);

    // Default sort is mtime desc → server returns insertion order (FILE_A, FILE_B).
    await expect(page.locator('[data-index="0"]')).toContainText("Alpha");
    await expect(page.locator('[data-index="1"]')).toContainText("Bravo");

    // Click Format header → ascending by file_format → .flac before .mp3.
    const sortRequest = page.waitForRequest((req) =>
      req.url().includes("sort_by=file_format"),
    );
    await header.locator("button", { hasText: "Format" }).click();
    await sortRequest;

    await expect(page.locator('[data-index="0"]')).toContainText("Alpha");
    await expect(
      page.locator('[data-index="0"] [data-format-cell]'),
    ).toHaveText("flac");
    await expect(
      page.locator('[data-index="1"] [data-format-cell]'),
    ).toHaveText("mp3");

    // Toggle to descending → .mp3 first.
    await header.locator("button", { hasText: "Format" }).click();
    await expect(
      page.locator('[data-index="0"] [data-format-cell]'),
    ).toHaveText("mp3");
    await expect(
      page.locator('[data-index="1"] [data-format-cell]'),
    ).toHaveText("flac");
  });
});
