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

interface PreviewBody {
  candidates: { name: string; size: number; mtime: number }[];
  skipped: string[];
}

async function setupPreview(
  page: import("@playwright/test").Page,
  preview: PreviewBody,
) {
  await page.route(
    "**/api/metadata/folders/fetch-from-downloads/preview**",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(preview),
      }),
  );
}

test.describe("Fetch from Downloads", () => {
  test("shows preview, posts request with selected window, sends file_names", async ({
    page,
  }) => {
    await setupBrowse(page);
    await setupPreview(page, {
      candidates: [
        { name: "recent.mp3", size: 1, mtime: 0 },
        { name: "another.flac", size: 2, mtime: 0 },
      ],
      skipped: ["already-there.mp3"],
    });

    let postedBody: {
      dest_path: string;
      window_days: number;
      file_names?: string[];
    } | null = null;
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

    // Pick the 7-day preset.
    await dialog.getByRole("radio", { name: "7d" }).click();

    // Preview surfaces the count + per-file list.
    await expect(dialog.getByTestId("fetch-preview-summary")).toContainText(
      "2 of 2",
    );
    await expect(dialog.getByText("1 already in folder")).toBeVisible();
    await expect(dialog.getByTestId("fetch-preview-item")).toHaveCount(2);

    await dialog.getByTestId("fetch-confirm").click();

    await expect.poll(() => postedBody?.window_days).toBe(7);
    expect(postedBody!.dest_path).toMatch(/\/music$/);
    expect(postedBody!.file_names).toEqual(["recent.mp3", "another.flac"]);

    await expect(page.getByText(/Moved 2 files/)).toBeVisible();
    await expect(dialog).not.toBeVisible();
  });

  test("excluding a file via x removes it from the request", async ({
    page,
  }) => {
    await setupBrowse(page);
    await setupPreview(page, {
      candidates: [
        { name: "keep.mp3", size: 1, mtime: 0 },
        { name: "drop.mp3", size: 2, mtime: 0 },
      ],
      skipped: [],
    });

    let posted: { file_names?: string[] } | null = null;
    await page.route(
      "**/api/metadata/folders/fetch-from-downloads",
      (route) => {
        posted = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            moved: ["keep.mp3"],
            skipped: [],
            errors: [],
          }),
        });
      },
    );

    await page.goto("/library");
    await page.getByTestId("fetch-from-downloads-trigger").first().click();
    const dialog = page.getByRole("dialog");

    await dialog.getByTestId("fetch-preview-toggle-drop.mp3").click();
    await expect(dialog.getByTestId("fetch-preview-summary")).toContainText(
      "1 of 2",
    );
    await expect(dialog.getByTestId("fetch-confirm")).toContainText("Fetch 1");

    await dialog.getByTestId("fetch-confirm").click();

    await expect.poll(() => posted?.file_names).toEqual(["keep.mp3"]);
  });

  test("custom window posts the typed number of days", async ({ page }) => {
    await setupBrowse(page);
    await setupPreview(page, {
      candidates: [{ name: "x.mp3", size: 1, mtime: 0 }],
      skipped: [],
    });

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
    await expect(dialog.getByTestId("fetch-preview-item")).toHaveCount(1);
    await dialog.getByTestId("fetch-confirm").click();

    await expect.poll(() => posted?.window_days).toBe(14);
  });
});
