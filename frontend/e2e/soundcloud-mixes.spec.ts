import { expect, test } from "./fixtures";

/**
 * SoundCloud "Mixes" section — personalized system playlists (Weekly Wave,
 * Daily Drops, Your Mix N). Accessed via the api-v2 session cookie path;
 * when the backend reports the feature unavailable (404) the section must
 * be hidden entirely so the rest of the library still works.
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
    // Pre-expand Mixes so its children render without a separate chevron
    // click. Tree expansion persists to localStorage per-storageKey; the
    // "me" tab uses library:soundcloud:me. Matches useTreeExpansion's key.
    window.localStorage.setItem(
      "tree-panel-expanded:library:soundcloud:me",
      JSON.stringify(["mixes"]),
    );
  });

  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
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
  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
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

const MIX_URN = "soundcloud:system-playlists:weekly:1";

test.describe("SoundCloud Mixes section", () => {
  test("shows reconnect CTA when backend reports feature unavailable (404)", async ({
    page,
  }) => {
    await setupAuth(page);
    await page.route("**/api/soundcloud/system-playlists", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "SoundCloud session cookie not configured" }),
      }),
    );

    await page.goto("/library?source=soundcloud");

    // Mixes group is rendered (not hidden). Clicking it surfaces a
    // reconnect CTA so the user has a path to enable the feature.
    const mixesRow = page.getByRole("button", { name: /^Mixes/ });
    await expect(mixesRow).toBeVisible();
    await mixesRow.click();
    await expect(page.getByText(/Mixes aren.t available yet/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Reconnect SoundCloud/ }),
    ).toBeVisible();
  });

  test("renders mixes and loads tracks when feature is available", async ({
    page,
  }) => {
    await setupAuth(page);

    await page.route("**/api/soundcloud/system-playlists", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          playlists: [
            {
              urn: MIX_URN,
              title: "Weekly Wave",
              short_title: "Weekly Wave",
              description: null,
              artwork_url: null,
              track_count: 2,
              last_updated: "2026-04-20T00:00:00Z",
              permalink_url: null,
              track_ids: [101, 102],
            },
          ],
        }),
      }),
    );

    await page.route(
      `**/api/soundcloud/system-playlists/**/tracks`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tracks: [
              {
                id: 101,
                urn: "soundcloud:tracks:101",
                title: "Wave One",
                user: { id: 10, username: "artist-a" },
                duration: 180_000,
                permalink_url: "https://soundcloud.com/a/one",
                artwork_url: null,
                genre: "House",
              },
              {
                id: 102,
                urn: "soundcloud:tracks:102",
                title: "Wave Two",
                user: { id: 11, username: "artist-b" },
                duration: 200_000,
                permalink_url: "https://soundcloud.com/b/two",
                artwork_url: null,
                genre: "Techno",
              },
            ],
          }),
        }),
    );

    await page.goto("/library?source=soundcloud");

    // Mixes group is rendered and (pre-expanded via init script) shows
    // Weekly Wave as a child. Clicking it loads the mix's tracks.
    await expect(page.getByRole("button", { name: /^Mixes/ })).toBeVisible();
    const weekly = page.getByRole("button", { name: /Weekly Wave/ });
    await expect(weekly).toBeVisible();
    await weekly.click();

    await expect(page.getByText("Wave One")).toBeVisible();
    await expect(page.getByText("Wave Two")).toBeVisible();
  });
});
