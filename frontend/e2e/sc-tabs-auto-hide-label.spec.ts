import { expect, test } from "./fixtures";

/**
 * The SoundCloud view's My Library / Discover / Search toggle uses the
 * shared auto-hide label pattern: only the active tab shows its label;
 * inactive tabs are icon-only and reveal their label on hover.
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
}

test("active SC tab shows label, inactive tabs collapse", async ({ page }) => {
  await setupAuth(page);
  await page.goto("/library?source=soundcloud&tab=me");

  const myLibrary = page.getByRole("radio", { name: "My Library" });
  const discover = page.getByRole("radio", { name: "Discover" });
  const search = page.getByRole("radio", { name: "Search" });

  await expect(myLibrary).toBeVisible();

  // The auto-hide pattern animates the label span between max-w-32 (active
  // or hovered) and max-w-0 (inactive, not hovered). Asserting on the class
  // captures intent without flaking on transition timing.
  const label = (tab: typeof myLibrary) =>
    tab.locator("span").filter({ hasText: /^.+$/ }).last();

  await expect(label(myLibrary)).toHaveClass(/max-w-32/);
  await expect(label(discover)).toHaveClass(/max-w-0/);
  await expect(label(search)).toHaveClass(/max-w-0/);

  await discover.click();
  await expect(page).toHaveURL(/tab=discover/);

  await expect(label(discover)).toHaveClass(/max-w-32/);
  await expect(label(myLibrary)).toHaveClass(/max-w-0/);
});
