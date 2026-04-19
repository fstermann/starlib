import { expect, test } from "./fixtures";

test.describe("Navigation", () => {
  test("sidebar has link to library", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("aside");
    const libraryLink = sidebar.getByRole("link", { name: /Library/i });
    await expect(libraryLink).toBeVisible();
  });

  test("can navigate to library from sidebar", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("aside");
    await sidebar.getByRole("link", { name: /Library/i }).click();
    await expect(page).toHaveURL(/\/library/);
  });

  test("sidebar logo links to home", async ({ page }) => {
    await page.goto("/library");
    const sidebar = page.locator("aside");
    const homeLink = sidebar.getByRole("link", { name: /Starlib/i });
    await homeLink.click();
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/(\?.*)?$/);
  });
});
