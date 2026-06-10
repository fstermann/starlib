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

test.describe("Library Format & Size columns + filters", () => {
  test.beforeEach(async ({ page }) => {
    const handleBrowse = (route: import("@playwright/test").Route) => {
      const url = new URL(route.request().url());
      const sortBy = url.searchParams.get("sort_by");
      const sortOrder = url.searchParams.get("sort_order") ?? "asc";
      const formats = url.searchParams.getAll("file_formats");
      const sizeMin = url.searchParams.get("size_min");
      const sizeMax = url.searchParams.get("size_max");
      let items = [FILE_A, FILE_B];
      if (formats.length) {
        items = items.filter((it) =>
          formats.includes(it.file_format.replace(/^\./, "").toLowerCase()),
        );
      }
      if (sizeMin !== null) {
        items = items.filter((it) => it.file_size >= Number(sizeMin));
      }
      if (sizeMax !== null) {
        items = items.filter((it) => it.file_size <= Number(sizeMax));
      }
      if (sortBy === "file_format") {
        items = [...items].sort((a, b) =>
          a.file_format.localeCompare(b.file_format),
        );
        if (sortOrder === "desc") items.reverse();
      } else if (sortBy === "file_size") {
        items = [...items].sort((a, b) => a.file_size - b.file_size);
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

    // Filter-values endpoint must surface file_formats + size range so the
    // adapter renders the new attributes.
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
          file_size_min: 5 * 1024 * 1024,
          file_size_max: 20 * 1024 * 1024,
        }),
      }),
    );
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

    // Third click resets to the default sort (mtime desc).
    const resetReq = page.waitForRequest(
      (req) =>
        req.url().includes("sort_by=mtime") &&
        req.url().includes("sort_order=desc"),
    );
    await header.locator("button", { hasText: "Format" }).click();
    await resetReq;
  });

  test("Size column renders human-readable bytes and sorts by size", async ({
    page,
  }) => {
    await page.goto("/library");
    await expect(page.locator("[data-index]")).toHaveCount(2);

    const header = page.getByRole("row").first();
    await expect(header.getByText("Size", { exact: true })).toBeVisible();

    const cells = page.locator("[data-size-cell]");
    await expect(cells).toHaveCount(2);
    await expect(page.locator('[data-index="0"] [data-size-cell]')).toHaveText(
      "20.0 MB",
    );
    await expect(page.locator('[data-index="1"] [data-size-cell]')).toHaveText(
      "5.0 MB",
    );

    const sortRequest = page.waitForRequest((req) =>
      req.url().includes("sort_by=file_size"),
    );
    await header.locator("button", { hasText: "Size" }).click();
    await sortRequest;

    // Ascending: bravo (5MB) first.
    await expect(page.locator('[data-index="0"] [data-size-cell]')).toHaveText(
      "5.0 MB",
    );
    await expect(page.locator('[data-index="1"] [data-size-cell]')).toHaveText(
      "20.0 MB",
    );
  });

  test("Filtering by file format hits the API", async ({ page }) => {
    await page.goto("/library?file_format=flac");
    await expect(page.locator("[data-index]")).toHaveCount(1);
    await expect(page.locator('[data-index="0"]')).toContainText("Alpha");
    await expect(
      page.locator('[data-index="0"] [data-format-cell]'),
    ).toHaveText("flac");
  });

  test("Added (mtime) header toggles between desc and asc on click", async ({
    page,
  }) => {
    await page.goto("/library");
    await expect(page.locator("[data-index]")).toHaveCount(2);

    const header = page.getByRole("row").first();
    const addedBtn = header.locator("button", { hasText: "Added" });

    // Default sort is mtime desc — clicking once should flip to asc.
    const ascReq = page.waitForRequest(
      (req) =>
        req.url().includes("sort_by=mtime") &&
        req.url().includes("sort_order=asc"),
    );
    await addedBtn.click();
    await ascReq;

    // Clicking again flips back to desc, not stuck.
    const descReq = page.waitForRequest(
      (req) =>
        req.url().includes("sort_by=mtime") &&
        req.url().includes("sort_order=desc"),
    );
    await addedBtn.click();
    await descReq;
  });

  test("Filtering by file size range hits the API", async ({ page }) => {
    await page.goto(`/library?file_sizeMin=${10 * 1024 * 1024}`);
    await expect(page.locator("[data-index]")).toHaveCount(1);
    await expect(page.locator('[data-index="0"]')).toContainText("Alpha");
  });
});
