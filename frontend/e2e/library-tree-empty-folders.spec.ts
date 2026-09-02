import { expect, test } from "./fixtures";

// The backend tree now includes directories without any indexed tracks. The
// tree view must render such nodes — without a count badge (zero renders
// nothing).

test.describe("Library tree — empty folders", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/metadata\/folders\/tree(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "/music",
          name: "music",
          children: [
            {
              id: "/music/collection",
              name: "collection",
              children: [],
              track_count: 30,
              filtered_count: null,
            },
            {
              id: "/music/empty",
              name: "empty",
              children: [],
              track_count: 0,
              filtered_count: null,
            },
          ],
          track_count: 30,
          filtered_count: null,
        }),
      }),
    );
  });

  test("empty folder renders without a count badge", async ({ page }) => {
    const tree = page.locator("div.border-r").first();
    const node = (name: string) =>
      tree.locator("button.w-full", { hasText: name });

    await page.goto("/library");

    // Expand the root to reveal its children.
    await node("music").locator("svg").first().click();

    await expect(node("empty")).toBeVisible();
    await expect(node("empty").locator("span.tabular-nums")).toHaveCount(0);
    await expect(node("collection")).toContainText("30");
  });
});
