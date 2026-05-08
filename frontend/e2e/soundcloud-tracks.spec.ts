import { expect, test } from "./fixtures";

/**
 * SoundCloud "Tracks" section — sibling to Likes/Reposts in the library tree
 * on the "me" tab. Fetches `/me/tracks` (or per-user equivalent on Discover)
 * and reuses the LikesTable rendering pipeline. Ordered by created_at desc.
 */

async function setupAuth(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
    window.localStorage.setItem(
      "sc_user",
      JSON.stringify({
        id: 1,
        username: "me",
        permalink: "me",
        avatar_url: null,
      }),
    );
  });

  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("https://api.soundcloud.com/me/reposts/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("**/api/soundcloud/system-playlists", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "unavailable" }),
    }),
  );
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );
}

test.describe("SoundCloud Tracks section", () => {
  test("renders user's own tracks ordered by created_at desc", async ({
    page,
  }) => {
    await setupAuth(page);

    await page.route("https://api.soundcloud.com/me/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            {
              id: 301,
              urn: "soundcloud:tracks:301",
              title: "Older Upload",
              user: { id: 1, username: "me" },
              duration: 180_000,
              permalink_url: "https://soundcloud.com/me/older",
              artwork_url: null,
              genre: "House",
              created_at: "2024-01-15T10:00:00Z",
            },
            {
              id: 302,
              urn: "soundcloud:tracks:302",
              title: "Newest Upload",
              user: { id: 1, username: "me" },
              duration: 200_000,
              permalink_url: "https://soundcloud.com/me/newest",
              artwork_url: null,
              genre: "Techno",
              created_at: "2025-08-01T10:00:00Z",
            },
            {
              id: 303,
              urn: "soundcloud:tracks:303",
              title: "Middle Upload",
              user: { id: 1, username: "me" },
              duration: 210_000,
              permalink_url: "https://soundcloud.com/me/middle",
              artwork_url: null,
              genre: "Drum & Bass",
              created_at: "2024-09-01T10:00:00Z",
            },
          ],
          next_href: null,
        }),
      }),
    );

    await page.goto("/library?source=soundcloud");

    const tracksRow = page.getByRole("button", { name: /^Tracks/ });
    await expect(tracksRow).toBeVisible();
    await tracksRow.click();

    await expect(page.getByText("Newest Upload")).toBeVisible();
    await expect(page.getByText("Middle Upload")).toBeVisible();
    await expect(page.getByText("Older Upload")).toBeVisible();

    // Newest must come before Middle, which must come before Older.
    const body = (await page.locator("body").innerText()) ?? "";
    const newestIdx = body.indexOf("Newest Upload");
    const middleIdx = body.indexOf("Middle Upload");
    const olderIdx = body.indexOf("Older Upload");
    expect(newestIdx).toBeGreaterThanOrEqual(0);
    expect(middleIdx).toBeGreaterThan(newestIdx);
    expect(olderIdx).toBeGreaterThan(middleIdx);
  });

  test("shows empty-state when user has no tracks", async ({ page }) => {
    await setupAuth(page);
    await page.route("https://api.soundcloud.com/me/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );

    await page.goto("/library?source=soundcloud&node=tracks");
    await expect(page.getByText(/No tracks found/)).toBeVisible();
  });
});
