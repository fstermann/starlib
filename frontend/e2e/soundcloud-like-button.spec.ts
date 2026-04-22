import { expect, test } from "./fixtures";

/**
 * Like button in the SoundCloud likes table.
 *
 * Covers:
 * - Button renders active (SoundCloud orange / aria-pressed=true) for tracks
 *   in the authenticated user's likes.
 * - Click fires DELETE /likes/tracks/{urn} and flips the active state off.
 * - A second click fires POST /likes/tracks/{urn} and flips it back on.
 */

const TRACK_URN = "soundcloud:tracks:42";

async function setup(page: import("@playwright/test").Page) {
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
        avatar_url: "https://example.com/me.png",
      }),
    );
  });

  // One liked track.
  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: [
          {
            id: 42,
            urn: TRACK_URN,
            title: "Test Track",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/test",
          },
        ],
        next_href: null,
      }),
    }),
  );

  // Other SC endpoints touched by soundcloud-view on mount.
  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
  await page.route("https://api.soundcloud.com/me/feed/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );

  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  );
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bpms: {} }),
    }),
  );
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );
}

test.describe("SoundCloud like button", () => {
  test("reflects liked state and toggles via POST/DELETE", async ({ page }) => {
    await setup(page);

    const likeCalls: { method: string }[] = [];
    await page.route("**/api/soundcloud/tracks/42/like", (route) => {
      likeCalls.push({ method: route.request().method() });
      route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/library?source=soundcloud");

    const button = page.getByTestId("soundcloud-like-button").first();
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("data-liked", "true");
    await expect(button).toHaveAttribute("aria-pressed", "true");

    // Unlike.
    await button.click();
    await expect(button).toHaveAttribute("data-liked", "false");
    await expect.poll(() => likeCalls.map((c) => c.method)).toContain("DELETE");

    // Re-like.
    await button.click();
    await expect(button).toHaveAttribute("data-liked", "true");
    await expect.poll(() => likeCalls.map((c) => c.method)).toContain("POST");
  });
});
