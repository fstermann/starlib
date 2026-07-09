import { expect, test } from "./fixtures";

// #399 — tree count badges must reflect the active filters and revert when
// filters clear. The backend returns `filtered_count` per node when a filter
// query is present; the tree structure (and `track_count`) stays stable.

type Node = {
  id: string;
  name: string;
  children: Node[];
  track_count: number;
  filtered_count: number | null;
};

function treeBody(filtered: boolean): Node {
  const mk = (id: string, name: string, total: number, filt: number): Node => ({
    id,
    name,
    children: [],
    track_count: total,
    filtered_count: filtered ? filt : null,
  });
  return {
    id: "/music",
    name: "music",
    children: [
      mk("/music/prepare", "prepare", 12, 3),
      mk("/music/collection", "collection", 30, 8),
      mk("/music/cleaned", "cleaned", 5, 0),
    ],
    track_count: 47,
    filtered_count: filtered ? 11 : null,
  };
}

test.describe("Library tree — filtered counts (#399)", () => {
  test.beforeEach(async ({ page }) => {
    // Override the fixture's tree route: reflect the filter query in the counts.
    await page.route(/\/api\/metadata\/folders\/tree(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      const filtered = url.searchParams.has("search");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(treeBody(filtered)),
      });
    });
  });

  test("badges reflect the filter and revert when it clears", async ({
    page,
  }) => {
    const tree = page.locator("div.border-r").first();
    // Tree rows are full-width buttons; folder-shortcut buttons in the header
    // are not, so `button.w-full` targets rows only.
    const node = (name: string) =>
      tree.locator("button.w-full", { hasText: name });

    await page.goto("/library");

    // Unfiltered: total counts.
    await expect(node("music")).toContainText("47");

    // Expand the root to reveal its children (chevron toggles expansion).
    await node("music").locator("svg").first().click();
    await expect(node("prepare")).toContainText("12");
    await expect(node("collection")).toContainText("30");
    await expect(node("cleaned")).toContainText("5");

    // Apply a filter — counts drop to the filtered result.
    await page.goto("/library?search=techno");
    await expect(node("music")).toContainText("11");
    await expect(node("prepare")).toContainText("3");
    await expect(node("collection")).toContainText("8");
    // A folder with zero matches shows no badge at all.
    await expect(node("cleaned").locator("span.tabular-nums")).toHaveCount(0);

    // Clearing the filter reverts to the total counts.
    await page.goto("/library");
    await expect(node("music")).toContainText("47");
    await expect(node("prepare")).toContainText("12");
    await expect(node("collection")).toContainText("30");
  });
});
