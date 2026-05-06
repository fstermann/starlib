import { expect, test } from "./fixtures";

/**
 * Weekly view: the new "release_type" filter (release vs repost). The feed
 * now includes both `track` and `track-repost` activities and tags each
 * track with `isRepost`; the schema-driven filter narrows the visible feed
 * to one or the other.
 *
 * This spec exercises the user-visible URL wiring — same pattern as the
 * existing weekly search/clear-all spec.
 */

async function mockSoundCloud(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
  });

  await page.route(/api\.soundcloud\.com\/me\/feed\/tracks/, (route) =>
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
  await page.route("**/api/collection/soundcloud-ids", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ids: [] }),
    }),
  );
}

test.describe("weekly release_type filter", () => {
  test.beforeEach(async ({ page }) => {
    await mockSoundCloud(page);
  });

  test("clear-all removes the release_type URL param", async ({ page }) => {
    await page.goto("/weekly?release_type=repost");
    await expect(page).toHaveURL(/release_type=repost/);

    await page.getByRole("button", { name: /clear all/i }).click();
    await expect(page).not.toHaveURL(/release_type/);
  });
});
