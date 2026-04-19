import { expect, test } from "./fixtures";

test.describe("Home page", () => {
  test("shows application title and tool cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Starlib" })).toBeVisible();
    await expect(
      page.getByText("Music management for DJs and producers."),
    ).toBeVisible();
  });

  test("displays Library card as available", async ({ page }) => {
    await page.goto("/");
    const main = page.locator("main");
    const card = main.getByRole("link", { name: /Library/i });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("href", "/library");
  });

  test("displays Weekly Favorites card as available", async ({ page }) => {
    await page.goto("/");
    const main = page.locator("main");
    const card = main.getByRole("link", { name: /Weekly Favorites/i });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("href", "/weekly");
  });

  test("navigates to library when clicking the card", async ({ page }) => {
    await page.goto("/");
    const main = page.locator("main");
    await main.getByRole("link", { name: /Library/i }).click();
    await expect(page).toHaveURL(/\/library/);
  });
});
