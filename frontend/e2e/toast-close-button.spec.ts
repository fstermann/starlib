import { expect, test } from "./fixtures";

/**
 * Toasts must render a close (x) button so the user can dismiss them
 * without waiting for the auto-timeout. Configured globally on the
 * Sonner Toaster.
 */
test.describe("toast close button", () => {
  test("toasts render a dismiss button that closes them on click", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __starlibToast?: unknown })
          .__starlibToast === "function",
    );
    await page.evaluate(() => {
      (
        window as unknown as { __starlibToast: (msg: string) => void }
      ).__starlibToast("Hello world toast");
    });

    const toast = page.getByText("Hello world toast");
    await expect(toast).toBeVisible();

    const closeBtn = page
      .locator('[data-sonner-toast] [data-close-button]')
      .first();
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(toast).toBeHidden();
  });
});
