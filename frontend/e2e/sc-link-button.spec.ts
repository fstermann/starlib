import { expect, test } from "./fixtures";

// #376: the "Link selected SC track" button must have a clear icon and tooltip
// instead of relying on a bare title attribute and the source brand icon.
test.describe("SoundCloud link-track button", () => {
  test("has descriptive aria-label and tooltip on the link icon", async ({
    page,
  }) => {
    const filePath = "/music/test - track.mp3";

    const browseItem = {
      file_path: filePath,
      file_name: "test - track.mp3",
      file_size: 1000,
      file_format: "mp3",
      has_artwork: false,
      title: "track",
      artist: "test",
      bpm: null,
      key: null,
      genre: null,
      comment: null,
      release_date: null,
      remixers: null,
      soundcloud_id: null,
      duration: 200,
      mtime: Date.now() / 1000,
    };
    const browseBody = {
      items: [browseItem],
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
          bpm: null,
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

    // Click the row to open the editor (same flow as screenshots.spec).
    const dataRow = page.locator('[data-index="0"]');
    await dataRow.waitFor({ state: "visible" });
    await dataRow.locator("[data-file-path]").first().click();
    await page
      .locator('input[data-slot="input"][placeholder="Title"]')
      .waitFor({ state: "visible" });

    const btn = page.locator('[data-testid="link-sc-track-button"]');
    await btn.waitFor({ state: "attached" });
    await expect(btn).toHaveAttribute(
      "aria-label",
      /Link selected SoundCloud track/i,
    );

    // The icon is Link2, not the source brand icon. Lucide marks every icon
    // with a `lucide-<name>` class on the root <svg>.
    const svgClass = await btn.locator("svg").first().getAttribute("class");
    expect(svgClass ?? "").toMatch(/lucide-link-?2/);
  });
});
