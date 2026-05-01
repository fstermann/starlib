import { expect, test } from "./fixtures";

// #375: while an Apply Rules call is in flight, the button must disable +
// show a spinner so the user gets feedback (the backend job is multi-second
// ffmpeg + file-move work). Without this they thought the app froze.
test("Apply Rules shows a busy state while the request is in flight", async ({
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

  // Set up a folder with a ruleset so the editor renders Apply Rules.
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

  // Slow apply-rules endpoint — held open for ~600ms so we can observe the
  // intermediate busy state.
  await page.route(/\/api\/metadata\/files\/.+\/apply-rules/, async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        message: "ok",
        new_file_path: filePath,
        steps: [],
      }),
    });
  });

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

  // Click → button should immediately flip to busy: disabled + data-applying.
  // Without the fix the button stayed enabled and the user could re-fire the
  // multi-second backend job, which read as "the whole app froze."
  await applyBtn.click();
  await expect(applyBtn).toBeDisabled();
  await expect(applyBtn).toHaveAttribute("data-applying", "true");
  await expect(applyBtn).toContainText(/Applying/i);
});
