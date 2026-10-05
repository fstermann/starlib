import { expect, test } from "./fixtures";

/**
 * Right-click a SoundCloud track → "Open playlist picks" navigates to a
 * synthetic picks node and renders tracks from the seed's public playlists,
 * ranked by how many of those playlists contain them.
 */

function authInit(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
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
}

async function setupLikesView(
  page: import("@playwright/test").Page,
  { sessionCookie }: { sessionCookie: boolean },
) {
  await authInit(page);
  await Promise.all([
    page.route("**/api/soundcloud/system-playlists", (route) =>
      sessionCookie
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ playlists: [] }),
          })
        : route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ detail: "not configured" }),
          }),
    ),
    page.route("https://api.soundcloud.com/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      }),
    ),
    page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    ),
    page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      }),
    ),
    page.route("**/api/bpm/soundcloud/bulk", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ bpms: {} }),
      }),
    ),
    page.route("**/api/settings/root-folder", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ root_music_folder: "/music" }),
      }),
    ),
    page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            {
              id: 42,
              urn: "soundcloud:tracks:42",
              title: "Track Alpha",
              user: { id: 1, username: "me" },
              duration: 200_000,
              permalink_url: "https://soundcloud.com/me/alpha",
            },
          ],
          next_href: null,
        }),
      }),
    ),
  ]);
}

function pick(id: number, title: string, count: number) {
  return {
    count,
    track: {
      id,
      urn: `soundcloud:tracks:${id}`,
      title,
      user: { id: id + 1000, username: `artist-${id}` },
      duration: 180_000,
      permalink_url: `https://soundcloud.com/a/${id}`,
    },
  };
}

test.describe("SoundCloud playlist picks", () => {
  test("opens picks from a track's context menu, ranked by playlist count", async ({
    page,
  }) => {
    await setupLikesView(page, { sessionCookie: true });

    const picksReq = page.waitForRequest("**/api/soundcloud/playlist-picks/42");
    await page.route("**/api/soundcloud/playlist-picks/42", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          playlist_count: 7,
          picks: [pick(501, "Often Shared", 5), pick(502, "Rarely Shared", 1)],
        }),
      }),
    );

    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(1, {
      timeout: 5000,
    });

    await page.locator('[data-index="0"]').click({ button: "right" });
    await page.getByTestId("open-playlist-picks").click();

    await expect(page).toHaveURL(/node=picks/);
    await (await picksReq).response();

    await expect(page.getByTestId("picks-header")).toContainText(
      "Playlist picks · Track Alpha",
    );
    await expect(page.getByTestId("picks-playlist-count")).toHaveText(
      "from 7 playlists",
    );
    // Backend order (highest count first) is kept, and the count column shows.
    await expect(page.locator('[data-index="0"]')).toContainText(
      "Often Shared",
    );
    await expect(page.locator('[data-index="0"]')).toContainText("5");
    await expect(page.locator('[data-index="1"]')).toContainText(
      "Rarely Shared",
    );
    // Sorting by the count column ascending flips the order.
    await page
      .getByRole("button", { name: "Playlists", exact: true })
      .last()
      .click();
    await expect(page.locator('[data-index="0"]')).toContainText(
      "Rarely Shared",
    );

    await page.getByTestId("picks-close").click();
    await expect(page.getByText("Track Alpha")).toBeVisible();
  });

  test("hides the menu item without a SoundCloud session cookie", async ({
    page,
  }) => {
    await setupLikesView(page, { sessionCookie: false });

    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(1, {
      timeout: 5000,
    });

    await page.locator('[data-index="0"]').click({ button: "right" });
    await expect(page.getByTestId("open-station")).toBeVisible();
    await expect(page.getByTestId("open-playlist-picks")).toHaveCount(0);
  });
});
