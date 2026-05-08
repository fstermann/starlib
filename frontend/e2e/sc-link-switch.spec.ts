import { expect, test } from "./fixtures";

// Regression for the bug where switching the selected SoundCloud track in the
// search panel didn't update the linked id on the file: the auto-link effect
// short-circuited with `prev.soundcloud_id || meta.source_id`, so a track
// that already had a SoundCloud link was forever pinned to that id even
// after the user clicked a different result.
test.describe("SoundCloud link — switching the selected track", () => {
  test("clicking a different SC result updates the saved soundcloud_id", async ({
    page,
  }) => {
    const filePath = "/music/test - track.mp3";
    const OLD_ID = "111111";
    const OLD_PERMALINK = "https://soundcloud.com/old/old-track";
    const NEW_ID = "222222";
    const NEW_PERMALINK = "https://soundcloud.com/new/new-track";

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
      soundcloud_id: OLD_ID,
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

    const trackInfo = {
      file_path: filePath,
      file_name: "test - track.mp3",
      title: "track",
      artist: "test",
      bpm: null,
      key: null,
      genre: null,
      release_date: null,
      release_year: null,
      original_artist: null,
      remixer: null,
      mix_name: null,
      user_comment: null,
      starlib_meta: `version=1.0; \nsoundcloud_id=${OLD_ID}; \nsoundcloud_permalink=${OLD_PERMALINK}`,
      has_artwork: false,
      is_ready: true,
      missing_fields: [],
      issues: [],
    };

    const saved: { body: { starlib_meta?: string | null } | null } = {
      body: null,
    };
    await page.route("**/api/metadata/files/*/info", (route) => {
      if (route.request().method() === "POST") {
        saved.body = JSON.parse(route.request().postData() ?? "{}");
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            new_file_path: filePath,
            updated_fields: ["starlib_meta"],
          }),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(trackInfo),
      });
    });
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
        body: JSON.stringify({ fields: {} }),
      }),
    );

    // Make ensureValidToken() resolve without hitting the refresh endpoint.
    await page.addInitScript(() => {
      localStorage.setItem("access_token", "test-token");
    });

    // SoundCloud API mocks. /resolve returns the OLD track (matches the
    // permalink that gets auto-searched on load); /tracks returns BOTH so
    // the user can click a different result.
    const oldScTrack = {
      id: Number(OLD_ID),
      urn: `soundcloud:tracks:${OLD_ID}`,
      title: "Old Track",
      permalink_url: OLD_PERMALINK,
      artwork_url: null,
      user: { username: "old" },
    };
    const newScTrack = {
      id: Number(NEW_ID),
      urn: `soundcloud:tracks:${NEW_ID}`,
      title: "New Track",
      permalink_url: NEW_PERMALINK,
      artwork_url: null,
      user: { username: "new" },
    };

    await page.route("**://api.soundcloud.com/resolve*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(oldScTrack),
      }),
    );
    await page.route("**://api.soundcloud.com/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([oldScTrack, newScTrack]),
      }),
    );

    await page.goto("/library");
    await page.waitForLoadState("networkidle");

    const dataRow = page.locator('[data-index="0"]');
    await dataRow.waitFor({ state: "visible" });
    await dataRow.locator("[data-file-path]").first().click();

    // Editor open; the auto-search resolves OLD via the permalink and selects it.
    await page
      .locator('input[data-slot="input"][placeholder="Title"]')
      .waitFor({ state: "visible" });

    // Open the SC search sidebar and force a non-URL search so /tracks is hit
    // and both results render. Replacing the query also exercises the
    // post-load "user retypes" path.
    await page.getByRole("button", { name: /^Search$/ }).click();
    const searchInput = page.locator(
      'input[placeholder*="Search SoundCloud" i], input[placeholder*="search" i]',
    );
    await searchInput.first().fill("track query");

    // Wait for both results to appear, then click the NEW one.
    await expect(page.getByText("New Track")).toBeVisible();
    await page.getByText("New Track").click();

    // The link row in the meta side should now reflect the NEW permalink.
    await expect(page.getByText(NEW_PERMALINK)).toBeVisible();

    // Save and assert the persisted starlib_meta carries NEW_ID, not OLD_ID.
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect.poll(() => saved.body?.starlib_meta ?? "").toContain(NEW_ID);
    expect(saved.body?.starlib_meta ?? "").not.toContain(OLD_ID);
  });
});
