import { expect, test } from "./fixtures";

// Regression for #372: reorder drag handles must be hidden until row hover,
// so they don't clutter every row in the resting state.
test.describe("drag handle hover affordance", () => {
  test("folder-config handle is hidden until row is hovered", async ({
    page,
  }) => {
    await page.goto("/library");
    await page.waitForLoadState("networkidle");

    await page.locator('button[aria-label="Settings"]').click();
    await page
      .locator('[data-slot="dialog-content"]')
      .waitFor({ state: "visible" });
    await page.getByText("Folders", { exact: true }).click();

    const handle = page
      .locator('[data-testid="folder-config-drag-handle"]')
      .first();
    await handle.waitFor({ state: "attached" });

    // Resting: opacity 0 (handle is in DOM and accessible, just invisible).
    expect(
      await handle.evaluate(
        (el) => parseFloat(getComputedStyle(el).opacity) || 0,
      ),
    ).toBeLessThan(0.05);

    // Hover the row that owns this handle: opacity transitions to 1.
    const row = handle.locator("xpath=ancestor::*[contains(@class,'group')][1]");
    await row.hover();
    await expect
      .poll(async () =>
        handle.evaluate(
          (el) => parseFloat(getComputedStyle(el).opacity) || 0,
        ),
      )
      .toBeGreaterThan(0.9);
  });
});
