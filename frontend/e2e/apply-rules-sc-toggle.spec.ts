import { expect, test } from "./fixtures";

// Toggling the per-track SoundCloud chip on a track with no linked SC id used
// to register as an "unsaved change", which tripped the unsaved-changes gate
// and disabled Apply Rules ("Save your changes before applying rules") even
// though nothing about the saved starlib_meta actually changed. The chip
// toggle must only count as an edit when it alters what handleSave writes.
test("toggling the SoundCloud chip on an unlinked track keeps Apply Rules enabled", async ({
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
        key: "Am",
        genre: "techno",
        comment: null,
        release_date: "2024-01-01",
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
        key: "Am",
        genre: "techno",
        comment: null,
        release_date: "2024-01-01",
        remixers: null,
        has_artwork: false,
        is_ready: true,
        missing_fields: [],
        issues: [],
      }),
    }),
  );

  const ruleset = {
    id: "rs-1",
    name: "Test",
    is_builtin: false,
    rules: [
      {
        id: "copy",
        type: "copy",
        input: "source",
        requires: [],
        params: { folder: "archive" },
      },
    ],
    required_attributes: [],
  };
  await page.route("**/api/rulesets", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rulesets: [ruleset],
        active_ruleset_id: ruleset.id,
      }),
    }),
  );
  await page.route("**/api/folders/rulesets-by-path", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        folder_rulesets: { "/music": { ruleset_id: "rs-1", recursive: true } },
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

  const applyBtn = page.locator('[data-testid="apply-rules-button"]');
  await applyBtn.waitFor({ state: "visible" });
  await expect(applyBtn).toBeEnabled();

  // Toggle the SoundCloud chip — no linked id exists, so saved metadata is
  // unchanged and Apply Rules must remain enabled (regression: it used to
  // disable with "Save your changes before applying rules").
  await page.getByTestId("sc-link-toggle").click();
  await expect(applyBtn).toBeEnabled();
});
