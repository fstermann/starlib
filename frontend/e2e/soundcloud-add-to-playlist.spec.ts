import { expect, test } from "./fixtures";

/**
 * SoundCloud playlist actions on a track row's context menu:
 *  - "Add to playlist ▸" submenu listing the user's own playlists, with a
 *    check on playlists that already contain the track.
 *  - "Remove from playlist" when viewing one of the user's own playlists.
 * SoundCloud's playlist PUT replaces the whole track set, so both actions read
 * the current tracks first and write the merged/filtered set back.
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

function commonRoutes(page: import("@playwright/test").Page) {
  return Promise.all([
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

const MY_PLAYLISTS = {
  collection: [
    {
      urn: "soundcloud:playlists:100",
      title: "My Set",
      track_count: 1,
      permalink_url: "https://soundcloud.com/me/sets/my-set",
    },
  ],
  next_href: null,
};

/** Likes view with one liked track (Alpha, id 42) and one playlist ("My Set")
 *  whose current tracks are supplied by `playlistTracks`. */
async function setupLikesView(
  page: import("@playwright/test").Page,
  playlistTracks: { id: number; urn: string }[],
) {
  await authInit(page);
  await commonRoutes(page);

  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
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
  );
  await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MY_PLAYLISTS),
    }),
  );
  await page.route("https://api.soundcloud.com/playlists/**", (route) => {
    const req = route.request();
    if (req.method() === "GET" && req.url().includes("/tracks")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: playlistTracks, next_href: null }),
      });
    }
    if (req.method() === "PUT") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          urn: "soundcloud:playlists:100",
          title: "My Set",
          permalink_url: "https://soundcloud.com/me/sets/my-set",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
}

test.describe("soundcloud playlist context-menu actions", () => {
  test("appends a track to a playlist that doesn't contain it yet", async ({
    page,
  }) => {
    await setupLikesView(page, [{ id: 1001, urn: "soundcloud:tracks:1001" }]);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(1, {
      timeout: 5000,
    });

    await page.locator('[data-index="0"]').click({ button: "right" });
    await page.getByTestId("playlist-add-trigger").hover();

    const item = page
      .getByTestId("playlist-add-item")
      .filter({ hasText: "My Set" });
    await expect(item).toBeVisible();
    // Not a member → no check, enabled.
    await expect(item).not.toHaveAttribute("data-member", "true");

    const putPromise = page.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        req.url().includes("/playlists/") &&
        !req.url().includes("/tracks"),
    );
    await item.click();
    const put = await putPromise;

    const urns = (
      put.postDataJSON() as { playlist: { tracks: { urn: string }[] } }
    ).playlist.tracks.map((t) => t.urn);
    expect(urns).toEqual(["soundcloud:tracks:1001", "soundcloud:tracks:42"]);

    await expect(page.getByText('Added to "My Set"')).toBeVisible();
  });

  test("adds every checkbox-selected track to a playlist", async ({ page }) => {
    await authInit(page);
    await commonRoutes(page);
    await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
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
            },
            {
              id: 99,
              urn: "soundcloud:tracks:99",
              title: "Track Bravo",
              user: { id: 1, username: "me" },
              duration: 200_000,
            },
          ],
          next_href: null,
        }),
      }),
    );
    await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MY_PLAYLISTS),
      }),
    );
    await page.route("https://api.soundcloud.com/playlists/**", (route) => {
      const req = route.request();
      if (req.method() === "GET" && req.url().includes("/tracks")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            collection: [{ id: 1001, urn: "soundcloud:tracks:1001" }],
            next_href: null,
          }),
        });
      }
      if (req.method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ urn: "soundcloud:playlists:100" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    await page.getByRole("checkbox", { name: /select all/i }).click();
    await page.locator('[data-index="0"]').click({ button: "right" });

    // Count is surfaced on the submenu trigger.
    const trigger = page.getByTestId("playlist-add-trigger");
    await expect(trigger).toHaveText(/Add to playlist \(2\)/);
    await trigger.hover();

    const putPromise = page.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        req.url().includes("/playlists/") &&
        !req.url().includes("/tracks"),
    );
    await page
      .getByTestId("playlist-add-item")
      .filter({ hasText: "My Set" })
      .click();
    const put = await putPromise;

    const urns = (
      put.postDataJSON() as { playlist: { tracks: { urn: string }[] } }
    ).playlist.tracks.map((t) => t.urn);
    // Existing track kept + both selected tracks appended.
    expect(urns).toEqual([
      "soundcloud:tracks:1001",
      "soundcloud:tracks:42",
      "soundcloud:tracks:99",
    ]);

    await expect(page.getByText('Added 2 tracks to "My Set"')).toBeVisible();
  });

  test("marks a playlist the track is already in and disables it", async ({
    page,
  }) => {
    // Playlist already contains the row's track (id 42).
    await setupLikesView(page, [{ id: 42, urn: "soundcloud:tracks:42" }]);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(1, {
      timeout: 5000,
    });

    await page.locator('[data-index="0"]').click({ button: "right" });
    await page.getByTestId("playlist-add-trigger").hover();

    const item = page
      .getByTestId("playlist-add-item")
      .filter({ hasText: "My Set" });
    // Membership resolves asynchronously → item flips to member + disabled.
    await expect(item).toHaveAttribute("data-member", "true");
    await expect(item).toHaveAttribute("data-disabled", "");
  });

  test("removes a track from the playlist being viewed", async ({ page }) => {
    await authInit(page);
    await commonRoutes(page);
    await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MY_PLAYLISTS),
      }),
    );

    const playlistTracks = [
      {
        id: 42,
        urn: "soundcloud:tracks:42",
        title: "Track Alpha",
        user: { id: 1, username: "me" },
        duration: 200_000,
      },
      {
        id: 1001,
        urn: "soundcloud:tracks:1001",
        title: "Track Beta",
        user: { id: 1, username: "me" },
        duration: 200_000,
      },
    ];
    await page.route("https://api.soundcloud.com/playlists/**", (route) => {
      const req = route.request();
      if (req.method() === "GET" && req.url().includes("/tracks")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ collection: playlistTracks, next_href: null }),
        });
      }
      if (req.method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ urn: "soundcloud:playlists:100" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    // Navigate straight into the playlist node (tab "me" is the default).
    await page.goto(
      "/library?source=soundcloud&node=pl:soundcloud:playlists:100",
    );
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    await page.locator('[data-index="0"]').click({ button: "right" });

    const putPromise = page.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        req.url().includes("/playlists/") &&
        !req.url().includes("/tracks"),
    );
    await page.getByTestId("playlist-remove").click();

    // Row disappears optimistically.
    await expect(page.locator("[data-index]")).toHaveCount(1);
    await expect(page.getByText("Track Beta")).toBeVisible();

    const put = await putPromise;
    const urns = (
      put.postDataJSON() as { playlist: { tracks: { urn: string }[] } }
    ).playlist.tracks.map((t) => t.urn);
    // Alpha (42) dropped, Beta (1001) kept.
    expect(urns).toEqual(["soundcloud:tracks:1001"]);
  });

  test("removes every checkbox-selected track from the playlist", async ({
    page,
  }) => {
    await authInit(page);
    await commonRoutes(page);
    await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MY_PLAYLISTS),
      }),
    );

    const playlistTracks = [
      {
        id: 42,
        urn: "soundcloud:tracks:42",
        title: "Track Alpha",
        user: { id: 1, username: "me" },
        duration: 200_000,
      },
      {
        id: 99,
        urn: "soundcloud:tracks:99",
        title: "Track Bravo",
        user: { id: 1, username: "me" },
        duration: 200_000,
      },
      {
        id: 1001,
        urn: "soundcloud:tracks:1001",
        title: "Track Beta",
        user: { id: 1, username: "me" },
        duration: 200_000,
      },
    ];
    await page.route("https://api.soundcloud.com/playlists/**", (route) => {
      const req = route.request();
      if (req.method() === "GET" && req.url().includes("/tracks")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ collection: playlistTracks, next_href: null }),
        });
      }
      if (req.method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ urn: "soundcloud:playlists:100" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    await page.goto(
      "/library?source=soundcloud&node=pl:soundcloud:playlists:100",
    );
    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });

    await page.getByRole("checkbox", { name: /select all/i }).click();
    await page.locator('[data-index="0"]').click({ button: "right" });

    const removeItem = page.getByTestId("playlist-remove");
    await expect(removeItem).toHaveText(/Remove from playlist \(3\)/);

    const putPromise = page.waitForRequest(
      (req) =>
        req.method() === "PUT" &&
        req.url().includes("/playlists/") &&
        !req.url().includes("/tracks"),
    );
    await removeItem.click();

    // All three selected rows disappear.
    await expect(page.locator("[data-index]")).toHaveCount(0);

    const put = await putPromise;
    const urns = (
      put.postDataJSON() as { playlist: { tracks: { urn: string }[] } }
    ).playlist.tracks.map((t) => t.urn);
    expect(urns).toEqual([]);
  });

  test("creates a playlist from the selection and refreshes the sidebar", async ({
    page,
  }) => {
    await authInit(page);
    await commonRoutes(page);
    // Pre-expand the sidebar "Playlists" group so its child nodes are visible.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "tree-panel-expanded:library:soundcloud:me",
        JSON.stringify(["playlists"]),
      );
    });
    await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
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
            },
            {
              id: 99,
              urn: "soundcloud:tracks:99",
              title: "Track Bravo",
              user: { id: 1, username: "me" },
              duration: 200_000,
            },
          ],
          next_href: null,
        }),
      }),
    );
    // Server keeps returning an empty list (SoundCloud's list is eventually
    // consistent) — the sidebar must show the new playlist optimistically from
    // the POST response, without waiting for a refetch.
    await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );
    // POST /playlists (create). `*` matches an optional query but not a
    // subpath, so it won't catch /playlists/{urn}.
    await page.route("https://api.soundcloud.com/playlists*", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            urn: "soundcloud:playlists:200",
            title: "My Mix",
            track_count: 2,
            permalink_url: "https://soundcloud.com/me/sets/my-mix",
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    });

    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    // Select both rows.
    await page.getByRole("checkbox", { name: /select all/i }).click();

    await page.locator('[data-index="0"]').click({ button: "right" });
    await page.getByTestId("playlist-create").click(); // label: "Create playlist (2)"

    // Fill the create dialog and submit.
    await page.getByLabel("Title").fill("My Mix");

    const postPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        req.url() === "https://api.soundcloud.com/playlists",
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const post = await postPromise;

    const urns = (
      post.postDataJSON() as { playlist: { tracks: { urn: string }[] } }
    ).playlist.tracks.map((t) => t.urn);
    expect(urns).toEqual(["soundcloud:tracks:42", "soundcloud:tracks:99"]);

    await expect(page.getByText('Playlist "My Mix" created')).toBeVisible();
    // Sidebar refetched and now shows the new playlist node.
    await expect(page.getByRole("button", { name: /My Mix/ })).toBeVisible();
  });
});
