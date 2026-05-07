import { expect, test } from "./fixtures";

/**
 * Discover tab with a multi-profile group: the Playlists tree should
 * render a member-folder layer (one node per profile) with that
 * profile's playlists nested under it. Single-profile groups stay flat.
 */

const ALICE_URN = "soundcloud:users:42";
const BOB_URN = "soundcloud:users:99";

const ALICE_PLAYLIST = {
  urn: "soundcloud:playlists:1001",
  title: "Alice Mix Vol. 1",
  track_count: 12,
  user: { id: 42, username: "alice", urn: ALICE_URN },
};

const BOB_PLAYLIST = {
  urn: "soundcloud:playlists:2002",
  title: "Bob Selects",
  track_count: 8,
  user: { id: 99, username: "bob", urn: BOB_URN },
};

async function setup(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({ aliceUrn, bobUrn }) => {
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
      // Pre-expand the Playlists group + both member folders so the
      // assertions don't depend on driving chevron clicks.
      window.localStorage.setItem(
        "tree-panel-expanded:library:soundcloud:discover",
        JSON.stringify(["playlists", `member:${aliceUrn}`, `member:${bobUrn}`]),
      );
    },
    { aliceUrn: ALICE_URN, bobUrn: BOB_URN },
  );

  // Seed a saved 2-member group so the page loads it via ?group=.
  await page.route("**/api/profile-groups", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        groups: [
          {
            id: "g-multi",
            name: "DJ Pair",
            members: [
              { user_urn: ALICE_URN, username: "alice", avatar_url: null },
              { user_urn: BOB_URN, username: "bob", avatar_url: null },
            ],
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
        ],
        active_group_id: "g-multi",
      }),
    }),
  );
  await page.route(/\/api\/profile-groups\/active$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );

  // Per-user playlists — alice and bob each return one playlist.
  await page.route(/api\.soundcloud\.com\/users\/[^/]+\/playlists/, (route) => {
    const url = route.request().url();
    const collection = url.includes(`%3A42`)
      ? [ALICE_PLAYLIST]
      : url.includes(`%3A99`)
        ? [BOB_PLAYLIST]
        : [];
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection, next_href: null }),
    });
  });

  // Per-user likes/reposts can be empty — Likes tree still renders.
  await page.route(
    /api\.soundcloud\.com\/users\/[^/]+\/(likes|reposts)\/tracks/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
  );

  // Quiet "me" endpoints.
  await page.route(
    /api\.soundcloud\.com\/me\/(likes|reposts)\/tracks/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
  );
  await page.route(/api\.soundcloud\.com\/me\/playlists/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
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

test.describe("Discover playlists tree (multi-profile group)", () => {
  test("renders a member-folder layer with each profile's playlists", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud&tab=discover&group=g-multi");

    // Wait until both members' playlist endpoints have been hit.
    await page.waitForResponse(
      (r) => r.url().includes("%3A42/playlists") && r.status() === 200,
    );
    await page.waitForResponse(
      (r) => r.url().includes("%3A99/playlists") && r.status() === 200,
    );

    // Sidebar tree was pre-expanded via localStorage. Each member folder
    // exists with that profile's playlists nested under it.
    await expect(page.getByRole("button", { name: /^alice/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^bob/ })).toBeVisible();
    await expect(page.getByText("Alice Mix Vol. 1")).toBeVisible();
    await expect(page.getByText("Bob Selects")).toBeVisible();
  });
});
