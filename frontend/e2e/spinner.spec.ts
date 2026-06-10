import { expect, test } from "./fixtures";

// The brand spinner replaces lucide's Loader2 across the app. Verify the new
// outline-shaped SVG is what actually renders in a real loading state.
test("brand spinner renders during the SoundCloud auth callback", async ({
  page,
}) => {
  // Block the token-exchange endpoint indefinitely so the page stays in its
  // "Authenticating…" state long enough to assert the spinner.
  await page.route("**/auth/soundcloud/result*", () => {
    /* never resolve */
  });

  await page.goto("/auth/soundcloud/callback?state=anything");

  await expect(page.getByText("Authenticating…")).toBeVisible();

  // The new spinner is a 1024x1024 logo-outline SVG (Loader2 was 24x24),
  // and it still spins via Tailwind's animate-spin utility. It's
  // aria-hidden so we assert via DOM count, not accessibility visibility.
  const spinner = page.locator("svg.animate-spin");
  await expect(spinner).toHaveCount(1);
  await expect(spinner).toHaveAttribute("viewBox", "0 0 1024 1024");
});
