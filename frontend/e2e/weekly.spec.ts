import { expect, test } from "./fixtures";

/**
 * Weekly favorites filter integration.
 *
 * The filter toolbar is schema-driven and URL-backed (same pattern as the
 * library view). This test exercises the user-visible surface end-to-end:
 * open /weekly, type into the search filter, and assert the URL picks up the
 * `?search=` param — which proves the FiltersToolbar is wired to useFilterState.
 */

async function mockSoundCloud(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
  });

  // Feed endpoint — return an empty activity stream so the page renders
  // without needing real data.
  await page.route(/api\.soundcloud\.com\/me\/feed\/tracks/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );

  // Playlists endpoint.
  await page.route(/api\.soundcloud\.com\/me\/playlists/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );

  // Collection SC ids.
  await page.route("**/api/collection/soundcloud-ids", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ids: [] }),
    }),
  );
}

test.describe("weekly filters", () => {
  test.beforeEach(async ({ page }) => {
    await mockSoundCloud(page);
  });

  test("filter toolbar syncs search query to the URL", async ({ page }) => {
    await page.goto("/weekly");

    const toggle = page.getByRole("button", { name: /^filters/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    // The compact-filter text control uses "…" as its placeholder.
    const searchInput = page.getByPlaceholder("…").first();
    await searchInput.fill("midnight");

    await expect(page).toHaveURL(/search=midnight/);
  });

  test("clear-all resets active filters", async ({ page }) => {
    await page.goto("/weekly?search=foo");

    await expect(page).toHaveURL(/search=foo/);

    await page.getByRole("button", { name: /clear all/i }).click();
    await expect(page).not.toHaveURL(/search=foo/);
  });
});
