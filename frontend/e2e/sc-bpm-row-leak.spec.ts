import { expect, test } from "./fixtures";

/**
 * Bugfix: BPM written via the SoundCloud likes table must stay attached to
 * its track when the row order changes (sort, playlist switch, reorder).
 *
 * Before the fix, virtualizer rows were keyed by index, so React reused the
 * same cell instance across different trackIds — the local `analyzedBpm`
 * state from track A would surface on whatever track now occupied A's row
 * slot. The fix gives the virtualizer a per-track `getItemKey` so cells
 * unmount/remount with their underlying track.
 */

const TRACK_A_URN = "soundcloud:tracks:42";
const TRACK_B_URN = "soundcloud:tracks:99";

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

  // Two liked tracks, A then B by API order.
  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: [
          {
            id: 42,
            urn: TRACK_A_URN,
            title: "Alpha track",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/alpha",
          },
          {
            id: 99,
            urn: TRACK_B_URN,
            title: "Bravo track",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/bravo",
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
}

test.describe("SC table — BPM stays attached to its track on resort", () => {
  test("dispatched BPM follows the track when sort flips row order", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    // Wait for both rows to render.
    const rows = page.locator("[data-index]");
    await expect(rows).toHaveCount(2, { timeout: 5000 });

    // Initial order: Alpha (index 0, id 42), Bravo (index 1, id 99).
    await expect(rows.nth(0)).toContainText("Alpha track");
    await expect(rows.nth(1)).toContainText("Bravo track");

    // Simulate batch-analyzer firing a result for track A (Alpha, id 42).
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("sc-bpm-updated", {
          detail: { trackId: 42, bpm: 120 },
        }),
      );
    });

    // Alpha's row shows 120; Bravo's row does not.
    await expect(rows.nth(0)).toContainText("120");
    await expect(rows.nth(1)).not.toContainText("120");

    // Sort by title descending so Bravo moves to index 0 and Alpha to index 1.
    // Click title header twice: first ASC (no order change), then DESC.
    const titleHeader = page.getByRole("button", { name: /^Title/i }).first();
    await titleHeader.click();
    await titleHeader.click();

    await expect(rows.nth(0)).toContainText("Bravo track");
    await expect(rows.nth(1)).toContainText("Alpha track");

    // Bug check: track A's BPM (120) must travel with Alpha to index 1, NOT
    // stick at index 0 where Bravo now lives.
    await expect(rows.nth(0)).not.toContainText("120");
    await expect(rows.nth(1)).toContainText("120");
  });
});
