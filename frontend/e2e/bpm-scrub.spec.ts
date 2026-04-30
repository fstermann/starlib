import { expect, test } from "./fixtures";

// #370: BPM widget replaces native up/down arrows with click-and-drag
// scrubbing while keeping direct numeric typing and integer steps.
test.describe("BPM scrub input", () => {
  test("dragging horizontally on the BPM input changes the value in integer steps", async ({
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

    // The bug was native up/down arrows — assert no spinner is rendered. The
    // CSS hides them via [appearance:textfield].
    await expect(bpm).toHaveCSS("appearance", "textfield");

    // Drag horizontally to scrub. pxPerUnit=4 default, so +40px ≈ +10 BPM.
    const box = await bpm.boundingBox();
    if (!box) throw new Error("BPM input has no bounding box");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move in small steps so move events fire.
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(startX + i * 4, startY, { steps: 1 });
    }
    await page.mouse.up();

    // Final value should be an integer ~10 above the start. Allow a small
    // tolerance for browser rounding of synthetic events.
    const finalValue = await bpm.inputValue();
    expect(Number.isInteger(parseFloat(finalValue))).toBe(true);
    const n = parseInt(finalValue, 10);
    expect(n).toBeGreaterThan(120);
    expect(n).toBeLessThanOrEqual(135);
  });
});
