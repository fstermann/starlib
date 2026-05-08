import { expect, test } from "./fixtures";

/**
 * SoundCloud "Reposts" section — sibling to Likes in the library tree on the
 * "me" tab. Fetches `/me/reposts/tracks` (or per-user equivalent on Discover)
 * and reuses the LikesTable rendering pipeline.
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

test.describe("SoundCloud Reposts section", () => {
  test("renders reposted tracks under the Reposts node on My Library", async ({
    page,
  }) => {
    await setupAuth(page);

    await page.route("https://api.soundcloud.com/me/reposts/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            {
              id: 201,
              urn: "soundcloud:tracks:201",
              title: "Reposted One",
              user: { id: 20, username: "artist-r" },
              duration: 220_000,
              permalink_url: "https://soundcloud.com/r/one",
              artwork_url: null,
              genre: "House",
            },
            {
              id: 202,
              urn: "soundcloud:tracks:202",
              title: "Reposted Two",
              user: { id: 21, username: "artist-s" },
              duration: 240_000,
              permalink_url: "https://soundcloud.com/s/two",
              artwork_url: null,
              genre: "Techno",
            },
          ],
          next_href: null,
        }),
      }),
    );

    await page.goto("/library?source=soundcloud");

    const repostsRow = page.getByRole("button", { name: /^Reposts/ });
    await expect(repostsRow).toBeVisible();
    await repostsRow.click();

    await expect(page.getByText("Reposted One")).toBeVisible();
    await expect(page.getByText("Reposted Two")).toBeVisible();
  });

  test("shows empty-state when user has no reposts", async ({ page }) => {
    await setupAuth(page);
    await page.route("https://api.soundcloud.com/me/reposts/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );

    await page.goto("/library?source=soundcloud&node=reposts");
    await expect(page.getByText(/No reposted tracks found/)).toBeVisible();
  });
});
