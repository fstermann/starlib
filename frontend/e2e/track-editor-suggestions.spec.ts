import { expect, test } from "./fixtures";

const MOCK_FILE = {
  file_path: "track.mp3",
  file_name: "Some Artist - Some Title.mp3",
  file_size: 5 * 1024 * 1024,
  file_format: ".mp3",
  has_artwork: false,
};

const MOCK_TRACK_INFO = {
  file_path: "track.mp3",
  file_name: "Some Artist - Some Title.mp3",
  title: null,
  artist: null,
  bpm: null,
  key: null,
  genre: null,
  release_date: null,
  release_year: null,
  original_artist: null,
  remixer: null,
  mix_name: null,
  user_comment: null,
  starlib_meta: null,
  has_artwork: false,
  is_ready: false,
  missing_fields: [],
  issues: [],
};

/**
 * Defaults: opens the editor with empty tags and a filename-only suggestion
 * payload. Individual tests override the suggestions response when they need
 * a richer set (multi-candidate, equal-to-current, etc.).
 */
async function setupEditor(
  page: import("@playwright/test").Page,
  options: { suggestions?: Record<string, unknown[]>; trackInfo?: object } = {},
) {
  const trackInfo = options.trackInfo ?? MOCK_TRACK_INFO;
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
  await page.route("**/api/metadata/files/*/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(trackInfo),
    }),
  );
  await page.route("**/api/metadata/files/*/peaks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ peaks: Array(200).fill(0.3) }),
    }),
  );
  await page.route("**/api/suggestions/track", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        fields: options.suggestions ?? {
          // Use distinctive values that differ from the editor's filename
          // auto-fill ("Some Title" / "Some Artist") so the equal-to-current
          // filter doesn't drop them.
          title: [
            {
              value: "Suggested Title",
              source: "sc_title",
              confidence: 0.9,
              label: "from SoundCloud title",
            },
          ],
          artist: [
            {
              value: "Suggested Artist",
              source: "sc_metadata_artist",
              confidence: 0.9,
              label: "SoundCloud metadata artist",
            },
          ],
        },
      }),
    }),
  );

  await page.goto("/library");
  await page.waitForLoadState("networkidle");
  await page.locator('[data-file-path="track.mp3"]').click();
  // Wait for the editor's title input to render.
  await expect(page.locator('input[placeholder="Title"]')).toBeVisible();
}

test.describe("Track editor — suggestions", () => {
  test("filename-only suggestions render when no SC track is linked", async ({
    page,
  }) => {
    await setupEditor(page);
    // The suggestion button shows up next to the input.
    await expect(
      page.locator('[data-suggestion-field="title"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-suggestion-field="artist"]'),
    ).toBeVisible();
  });

  test("opening a track does not write the suggested values into fields", async ({
    page,
  }) => {
    // The SC suggestion is "Suggested Title" but the form starts at the
    // filename-parse fallback "Some Title". This regression-tests the
    // auto-copy removal: SC suggestions never silently flow into fields.
    await setupEditor(page);
    const titleInput = page.locator('input[placeholder="Title"]');
    await expect(
      page.locator('[data-suggestion-field="title"]'),
    ).toBeVisible();
    await expect(titleInput).not.toHaveValue("Suggested Title");
  });

  test("accepting a title suggestion writes only that field", async ({
    page,
  }) => {
    await setupEditor(page);
    const titleInput = page.locator('input[placeholder="Title"]');
    const artistInput = page.locator('input[placeholder="Artist"]');
    // Wait for the suggestion button to show up before clicking.
    await expect(
      page.locator('[data-command-id="suggestion-accept-title"]'),
    ).toBeVisible();
    const artistBefore = await artistInput.inputValue();

    await page
      .locator('[data-command-id="suggestion-accept-title"]')
      .first()
      .click();

    await expect(titleInput).toHaveValue("Suggested Title");
    // Artist value is untouched by the title accept.
    await expect(artistInput).toHaveValue(artistBefore);
  });

  test("popover lists multiple candidates with source labels", async ({
    page,
  }) => {
    await setupEditor(page, {
      suggestions: {
        artist: [
          {
            value: "Foo",
            source: "sc_metadata_artist",
            confidence: 0.9,
            label: "SoundCloud metadata artist",
          },
          {
            value: "Bar",
            source: "filename_parse",
            confidence: 0.5,
            label: "from filename",
          },
        ],
      },
    });
    // Open the alternatives popover via the chevron split-button.
    await page
      .locator('[data-command-id="suggestion-open-artist"]')
      .first()
      .click();

    // Both candidates render with their source labels.
    await expect(page.getByText("SoundCloud metadata artist")).toBeVisible();
    await expect(page.getByText("from filename")).toBeVisible();
    // Click the second candidate (filename source) to accept.
    await page.locator('[data-suggestion-source="filename_parse"]').click();
    await expect(page.locator('input[placeholder="Artist"]')).toHaveValue(
      "Bar",
    );
  });

  test("accept-all updates every suggested field in one click", async ({
    page,
  }) => {
    await setupEditor(page);
    await expect(
      page.locator('[data-command-id="suggestion-accept-all"]'),
    ).toBeVisible();
    await page.locator('[data-command-id="suggestion-accept-all"]').click();

    await expect(page.locator('input[placeholder="Title"]')).toHaveValue(
      "Suggested Title",
    );
    await expect(page.locator('input[placeholder="Artist"]')).toHaveValue(
      "Suggested Artist",
    );
  });

  test("button is hidden when current value equals top suggestion", async ({
    page,
  }) => {
    // Track is loaded with title already matching the title suggestion. The
    // engine has nothing left to offer for title → no button. Artist gets a
    // suggestion that *differs* from the filename auto-fill ("Some Artist")
    // so its button is still rendered.
    await setupEditor(page, {
      trackInfo: {
        ...MOCK_TRACK_INFO,
        title: "Some Title",
      },
      suggestions: {
        artist: [
          {
            value: "Different Artist",
            source: "sc_metadata_artist",
            confidence: 0.9,
            label: "SoundCloud metadata artist",
          },
        ],
      },
    });
    await expect(page.locator('input[placeholder="Title"]')).toHaveValue(
      "Some Title",
    );
    // Title input has no suggestion button rendered.
    await expect(
      page.locator('[data-suggestion-field="title"]'),
    ).toHaveCount(0);
    // Artist still has one.
    await expect(
      page.locator('[data-suggestion-field="artist"]'),
    ).toBeVisible();
  });

  test("accept-all hover swaps inputs to suggested values, unhover restores", async ({
    page,
  }) => {
    await setupEditor(page);
    const trigger = page.locator('[data-command-id="suggestion-accept-all"]');
    await expect(trigger).toBeVisible();

    const titleInput = page.locator('input[placeholder="Title"]');
    const artistInput = page.locator('input[placeholder="Artist"]');
    const titleBefore = await titleInput.inputValue();
    const artistBefore = await artistInput.inputValue();

    // Hover → inputs render the suggested values without persisting them.
    await trigger.hover();
    await expect(titleInput).toHaveValue("Suggested Title");
    await expect(artistInput).toHaveValue("Suggested Artist");

    // Move the cursor away → original values come back.
    await page.locator("body").hover({ position: { x: 1, y: 1 } });
    await expect(titleInput).toHaveValue(titleBefore);
    await expect(artistInput).toHaveValue(artistBefore);
  });

  test("list-aggregated artist candidate is offered and applied", async ({
    page,
  }) => {
    await setupEditor(page, {
      suggestions: {
        artist: [
          {
            value: "Foo",
            source: "sc_metadata_artist",
            confidence: 0.9,
            label: "SoundCloud metadata artist",
          },
          {
            value: "Foo, Bar",
            source: "list_aggregated",
            confidence: 0.7,
            label: "combined from all sources",
          },
        ],
      },
    });
    await page
      .locator('[data-command-id="suggestion-open-artist"]')
      .first()
      .click();
    await page.locator('[data-suggestion-source="list_aggregated"]').click();
    await expect(page.locator('input[placeholder="Artist"]')).toHaveValue(
      "Foo, Bar",
    );
  });
});
