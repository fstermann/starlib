import { expect, test } from "./fixtures";

test.describe("Hyperspace loader", () => {
  test("plays hyperspace animation, then hands off to home", async ({
    page,
  }) => {
    await page.goto("/");

    // Loader is mounted on first paint and the canvas is present.
    const canvas = page.getByTestId("hyperspace-canvas");
    await expect(canvas).toBeVisible();

    // Loader unmounts and the title screen appears.
    await expect(page.getByRole("heading", { name: "Starlib" })).toBeVisible();
    await expect(canvas).toHaveCount(0);
  });
});
