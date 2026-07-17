import { expect, test } from "./fixtures";

/**
 * Right-click a playlist node in the sidebar (own playlists / "me" tab) to
 * rename or delete it. Both write to SoundCloud (PUT title / DELETE) and the
 * sidebar refreshes via the shared playlist reload.
 */

function baseRoutes(page: import("@playwright/test").Page) {
  return Promise.all([
    page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    ),
    page.route("https://api.soundcloud.com/tracks*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      }),
    ),
    page.route("https://api.soundcloud.com/me/feed/tracks*", (route) =>
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
  ]);
}

/** Auth + a pre-expanded "Playlists" sidebar group so playlist nodes show. */
function initState(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
    window.localStorage.setItem(
      "sc_user",
      JSON.stringify({ id: 1, username: "me", permalink: "me" }),
    );
    window.localStorage.setItem(
      "tree-panel-expanded:library:soundcloud:me",
      JSON.stringify(["playlists"]),
    );
  });
}

test.describe("soundcloud playlist sidebar management", () => {
  test("renames a playlist from its sidebar context menu", async ({ page }) => {
    await initState(page);
    await baseRoutes(page);

    // Server keeps returning the OLD title (SoundCloud's list is eventually
    // consistent) — the sidebar must reflect the rename optimistically.
    await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            {
              urn: "soundcloud:playlists:100",
              title: "My Set",
              track_count: 3,
            },
          ],
          next_href: null,
        }),
      }),
    );
    await page.route("https://api.soundcloud.com/playlists/**", (route) => {
      const req = route.request();
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as { playlist: { title?: string } };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            urn: "soundcloud:playlists:100",
            title: body.playlist.title ?? "My Set",
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    await page.goto("/library?source=soundcloud");
    const node = page.getByRole("button", { name: /My Set/ });
    await expect(node).toBeVisible({ timeout: 5000 });

    await node.click({ button: "right" });
    await page.getByTestId("playlist-rename").click();

    await page.getByLabel("Title").fill("Renamed Set");
    const putPromise = page.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        req.url().includes("/playlists/") &&
        !req.url().includes("/tracks"),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const put = await putPromise;

    expect(
      (put.postDataJSON() as { playlist: { title: string } }).playlist.title,
    ).toBe("Renamed Set");

    // Sidebar refetches and shows the new name.
    await expect(
      page.getByRole("button", { name: /Renamed Set/ }),
    ).toBeVisible();
  });

  test("deletes a playlist from its sidebar context menu", async ({ page }) => {
    await initState(page);
    await baseRoutes(page);

    // Server keeps returning the playlist even after DELETE (SoundCloud's list
    // is eventually consistent) — the sidebar must drop it optimistically.
    await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: [
            {
              urn: "soundcloud:playlists:100",
              title: "My Set",
              track_count: 3,
            },
          ],
          next_href: null,
        }),
      }),
    );
    // Delete is proxied through the backend (SoundCloud blocks DELETE via CORS).
    await page.route("**/api/soundcloud/playlists/*", (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({ status: 204, body: "" });
      }
      return route.fallback();
    });

    await page.goto("/library?source=soundcloud");
    const node = page.getByRole("button", { name: /My Set/ });
    await expect(node).toBeVisible({ timeout: 5000 });

    await node.click({ button: "right" });
    await page.getByTestId("playlist-delete").click();

    const deletePromise = page.waitForRequest(
      (req) =>
        req.method() === "DELETE" &&
        req.url().includes("/api/soundcloud/playlists/"),
    );
    await page.getByTestId("playlist-delete-confirm").click();
    await deletePromise;

    // Sidebar refetches; the node is gone.
    await expect(page.getByRole("button", { name: /My Set/ })).toHaveCount(0);
  });
});
