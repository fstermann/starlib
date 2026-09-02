import { expect, test } from "./fixtures";

/**
 * Bugfix: when a filter is applied while autoplay is running in the SoundCloud
 * view, tracks that the filter excludes must drop out of the autoplay queue.
 * The queue is snapshotted when playback starts, so without reconciliation the
 * player would keep advancing into now-hidden tracks.
 */

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
        avatar_url: null,
      }),
    );
  });

  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: [
          {
            id: 42,
            urn: "soundcloud:tracks:42",
            title: "Keep Alpha",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/alpha",
          },
          {
            id: 99,
            urn: "soundcloud:tracks:99",
            title: "Drop Bravo",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/bravo",
          },
          {
            id: 7,
            urn: "soundcloud:tracks:7",
            title: "Keep Charlie",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/charlie",
          },
        ],
        next_href: null,
      }),
    }),
  );
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
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
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
  await page.route("**/api/soundcloud/tracks/*/stream*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://example.com/fake.m3u8",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }),
  );
}

test.describe("soundcloud filter + autoplay", () => {
  test("filtering out a queued track drops it from autoplay", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });

    // Start playing Alpha — queues [Alpha, Bravo, Charlie].
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await page.locator('[data-index="0"]').click();
      });

    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();
    await expect(player).toContainText("Keep Alpha");

    // Apply a filter that hides Bravo but keeps Alpha (still playing) and
    // Charlie. This mutates the URL client-side — no reload — so the player
    // and its queue survive.
    await page.getByRole("button", { name: /^filters$/i }).click();
    await page.getByPlaceholder("…").fill("keep");

    // Bravo drops out of the visible table (Alpha + Charlie remain).
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    // Autoplay's "next" must now skip the filtered-out Bravo and land on
    // Charlie. Pre-fix it would have advanced to Bravo.
    await player.getByRole("button", { name: "Next track" }).click();
    await expect(player).toContainText("Keep Charlie");
    await expect(player).not.toContainText("Drop Bravo");
  });
});
