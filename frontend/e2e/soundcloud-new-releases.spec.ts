import { expect, test } from "./fixtures";

/**
 * SoundCloud "New Today" / "New This Week" smart lists — flat nodes at the top
 * of the library tree on the "me" tab. Both are fed by the personal followings
 * feed (`/me/feed/tracks`, posts + reposts by people you follow) and narrowed
 * to tracks whose own *release date* falls inside today / the current week.
 *
 * A track reposted today but released earlier must NOT appear — the window is
 * on the track's release date, not when it surfaced on the feed.
 */

// Frozen "now": Wednesday 2025-06-18. Week starts the prior Sunday (2025-06-15).
const NOW = "2025-06-18T15:00:00Z";

const FEED = {
  collection: [
    {
      type: "track",
      created_at: "2025-06-18T09:00:00Z", // surfaced today
      origin: {
        id: 301,
        urn: "soundcloud:tracks:301",
        title: "Released Today Track",
        created_at: "2025-06-18T09:00:00Z", // released today
        user: { id: 30, username: "artist-a" },
        duration: 200_000,
        permalink_url: "https://soundcloud.com/a/today",
        artwork_url: null,
        genre: "House",
      },
    },
    {
      type: "track",
      created_at: "2025-06-16T10:00:00Z", // surfaced Monday
      origin: {
        id: 302,
        urn: "soundcloud:tracks:302",
        title: "Released Monday Track",
        created_at: "2025-06-16T10:00:00Z", // released Monday (this week, not today)
        user: { id: 31, username: "artist-b" },
        duration: 210_000,
        permalink_url: "https://soundcloud.com/b/monday",
        artwork_url: null,
        genre: "Techno",
      },
    },
    {
      type: "track:repost",
      created_at: "2025-06-18T08:00:00Z", // reposted today...
      origin: {
        id: 303,
        urn: "soundcloud:tracks:303",
        title: "Old Reposted Track",
        created_at: "2025-06-05T10:00:00Z", // ...but released 13 days ago
        user: { id: 32, username: "artist-c" },
        duration: 220_000,
        permalink_url: "https://soundcloud.com/c/old",
        artwork_url: null,
        genre: "House",
      },
    },
  ],
  next_href: null,
};

async function setup(page: import("@playwright/test").Page) {
  await page.clock.setFixedTime(new Date(NOW));

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

  await page.route(/api\.soundcloud\.com\/me\/feed\/tracks/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FEED),
    }),
  );

  // Other "me"-tab sources fetched on load — keep them empty so only the feed
  // drives the assertions.
  for (const path of [
    "https://api.soundcloud.com/me/likes/tracks*",
    "https://api.soundcloud.com/me/reposts/tracks*",
    "https://api.soundcloud.com/me/tracks*",
    "https://api.soundcloud.com/me/playlists*",
  ]) {
    await page.route(path, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );
  }
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

test.describe("SoundCloud New Today / New This Week", () => {
  test("filters feed releases by their own release date", async ({ page }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    // Both smart nodes appear at the top of the tree on the "me" tab.
    const newTodayRow = page.getByRole("button", { name: /^New Today/ });
    const newWeekRow = page.getByRole("button", { name: /^New This Week/ });
    await expect(newTodayRow).toBeVisible();
    await expect(newWeekRow).toBeVisible();

    // New Today → only the track released today.
    await newTodayRow.click();
    await expect(page.getByText("Released Today Track")).toBeVisible();
    await expect(page.getByText("Released Monday Track")).toHaveCount(0);
    await expect(page.getByText("Old Reposted Track")).toHaveCount(0);

    // New This Week → today's + Monday's release, but not the 13-day-old track
    // that only got reposted today.
    await newWeekRow.click();
    await expect(page.getByText("Released Today Track")).toBeVisible();
    await expect(page.getByText("Released Monday Track")).toBeVisible();
    await expect(page.getByText("Old Reposted Track")).toHaveCount(0);
  });

  test("smart nodes are absent on the Discover tab", async ({ page }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud&tab=discover");

    await expect(page.getByRole("button", { name: /^New Today/ })).toHaveCount(
      0,
    );
  });
});
