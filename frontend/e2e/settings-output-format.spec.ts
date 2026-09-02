import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Output format is backend-owned (single source of truth read by the rule
 * engine). These tests pin that the settings dialog reads it from
 * `GET /api/settings` and writes it via `PUT /api/settings` — never a
 * frontend-local copy that could drift.
 */
async function mockSettings(page: Page, format: "aiff" | "mp3") {
  const puts: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/settings\/root-folder$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );
  await page.route(/\/api\/settings$/, (route) => {
    const req = route.request();
    let outFormat = format;
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData() ?? "{}");
      puts.push(body);
      if (body.preferred_output_format)
        outFormat = body.preferred_output_format;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        preferred_output_format: outFormat,
        root_music_folder: "/music",
      }),
    });
  });
  return puts;
}

async function openLibrarySettings(page: Page) {
  await page.goto("/library");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Library" }).click();
  return dialog;
}

test.describe("Settings — output format (backend-owned)", () => {
  test("reads the current format from the backend", async ({ page }) => {
    await mockSettings(page, "mp3");
    const dialog = await openLibrarySettings(page);

    // The backend says mp3 → the MP3 toggle is active, not the store default.
    await expect(dialog.getByRole("radio", { name: "MP3" })).toHaveAttribute(
      "data-state",
      "on",
    );
  });

  test("writing the format persists to the backend", async ({ page }) => {
    const puts = await mockSettings(page, "aiff");
    const dialog = await openLibrarySettings(page);

    await expect(dialog.getByRole("radio", { name: "AIFF" })).toHaveAttribute(
      "data-state",
      "on",
    );
    await dialog.getByRole("radio", { name: "MP3" }).click();

    // A PUT /api/settings carried the new format.
    await expect
      .poll(() => puts.find((b) => b.preferred_output_format === "mp3"))
      .toBeTruthy();
    await expect(dialog.getByRole("radio", { name: "MP3" })).toHaveAttribute(
      "data-state",
      "on",
    );
  });
});
