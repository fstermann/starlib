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

  test("topbar logo links to home", async ({ page }) => {
    await page.goto("/library");
    const topbar = page.locator("header");
    const homeLink = topbar.getByRole("link", { name: /Starlib/i });
    await homeLink.click();
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/(\?.*)?$/);
  });

  test.describe("back/forward arrows", () => {
    test("arrows are disabled with no history in that direction", async ({
      page,
    }) => {
      await page.goto("/");
      const topbar = page.locator("header");
      await expect(
        topbar.getByRole("button", { name: /go back/i }),
      ).toBeDisabled();
      await expect(
        topbar.getByRole("button", { name: /go forward/i }),
      ).toBeDisabled();
    });

    test("arrows reflect history and navigate", async ({ page }) => {
      await page.goto("/");
      const topbar = page.locator("header");
      const back = topbar.getByRole("button", { name: /go back/i });
      const forward = topbar.getByRole("button", { name: /go forward/i });

      await page
        .locator("aside")
        .getByRole("link", { name: /Library/i })
        .click();
      await expect(page).toHaveURL(/\/library/);

      // A visited entry now exists behind us; nothing ahead.
      await expect(back).toBeEnabled();
      await expect(forward).toBeDisabled();

      await back.click();
      await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/(\?.*)?$/);
      await expect(forward).toBeEnabled();

      await forward.click();
      await expect(page).toHaveURL(/\/library/);
    });

    test("keyboard shortcuts drive back and forward", async ({ page }) => {
      await page.goto("/");
      await page
        .locator("aside")
        .getByRole("link", { name: /Library/i })
        .click();
      await expect(page).toHaveURL(/\/library/);

      await page.locator("body").press("Meta+[");
      await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/(\?.*)?$/);

      await page.locator("body").press("Meta+]");
      await expect(page).toHaveURL(/\/library/);
    });
  });
});
