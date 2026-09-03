import { expect, test } from "./fixtures";

/**
 * Right-click a SoundCloud track → "Open track station" navigates to a
 * synthetic station node and renders the station's related tracks (proxied
 * from api-v2 by the backend) as a playlist-style view.
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

async function setupLikesView(page: import("@playwright/test").Page) {
  await authInit(page);
  await Promise.all([
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

test.describe("SoundCloud track station", () => {
  test("opens a station from a track's context menu and renders its tracks", async ({
    page,
  }) => {
    await setupLikesView(page);

    const stationReq = page.waitForRequest(
      "**/api/soundcloud/stations/42/tracks",
    );
    await page.route("**/api/soundcloud/stations/42/tracks", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: "Track station: Track Alpha",
          tracks: [
            {
              id: 501,
              urn: "soundcloud:tracks:501",
              title: "Station One",
              user: { id: 10, username: "artist-a" },
              duration: 180_000,
              permalink_url: "https://soundcloud.com/a/one",
            },
            {
              id: 502,
              urn: "soundcloud:tracks:502",
              title: "Station Two",
              user: { id: 11, username: "artist-b" },
              duration: 200_000,
              permalink_url: "https://soundcloud.com/b/two",
            },
          ],
        }),
      }),
    );

    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(1, {
      timeout: 5000,
    });

    await page.locator('[data-index="0"]').click({ button: "right" });
    await page.getByTestId("open-station").click();

    // Navigated to the synthetic station node and hit the backend station endpoint.
    await expect(page).toHaveURL(/node=station/);
    await (await stationReq).response();

    // Station header + related tracks render as a playlist-style view.
    await expect(page.getByTestId("station-header")).toContainText(
      "Track station",
    );
    await expect(page.getByText("Station One")).toBeVisible();
    await expect(page.getByText("Station Two")).toBeVisible();

    // "Back to likes" returns to the likes node.
    await page.getByTestId("station-close").click();
    await expect(page.getByText("Track Alpha")).toBeVisible();
  });
});
