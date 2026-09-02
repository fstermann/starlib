import { expect, test } from "./fixtures";

/**
 * Queue Preview panel: a right-side sheet opened from the player bar that lists
 * the now-playing track and the upcoming queue. Upcoming rows support
 * click-to-jump, remove, and drag/keyboard reorder. Driven through the
 * SoundCloud view, whose autoplay snapshots the visible list into the queue.
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
            title: "Track Alpha",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/alpha",
          },
          {
            id: 99,
            urn: "soundcloud:tracks:99",
            title: "Track Bravo",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/bravo",
          },
          {
            id: 7,
            urn: "soundcloud:tracks:7",
            title: "Track Charlie",
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

/** Start Alpha, queueing [Alpha, Bravo, Charlie]. Leaves the panel closed. */
async function startPlaying(page: import("@playwright/test").Page) {
  await page.goto("/library?source=soundcloud");
  await expect(page.locator("[data-index]")).toHaveCount(3, { timeout: 5000 });

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
  await expect(player).toContainText("Track Alpha");
  return player;
}

/** Start Alpha, queueing [Alpha, Bravo, Charlie], and open the queue panel. */
async function startAndOpenQueue(page: import("@playwright/test").Page) {
  const player = await startPlaying(page);
  await page.getByTestId("queue-trigger").click();
  const panel = page.getByTestId("queue-panel");
  await expect(panel).toBeVisible();
  return { player, panel };
}

test.describe("queue panel", () => {
  test("lists now-playing and upcoming tracks", async ({ page }) => {
    await setup(page);
    const { panel } = await startAndOpenQueue(page);

    await expect(panel.getByTestId("queue-now-playing")).toContainText(
      "Track Alpha",
    );
    const items = panel.getByTestId("queue-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Track Bravo");
    await expect(items.nth(1)).toContainText("Track Charlie");
  });

  test("clicking an upcoming track jumps playback to it", async ({ page }) => {
    await setup(page);
    const { player, panel } = await startAndOpenQueue(page);

    await panel.getByRole("button", { name: /play track charlie/i }).click();

    await expect(player).toContainText("Track Charlie");
    await expect(panel.getByTestId("queue-now-playing")).toContainText(
      "Track Charlie",
    );
    // Charlie is last — nothing left to queue.
    await expect(panel.getByTestId("queue-item")).toHaveCount(0);
  });

  test("removing an upcoming track drops it from the queue", async ({
    page,
  }) => {
    await setup(page);
    const { player, panel } = await startAndOpenQueue(page);

    await panel
      .getByTestId("queue-item")
      .filter({ hasText: "Track Bravo" })
      .getByTestId("queue-item-remove")
      .click();

    const items = panel.getByTestId("queue-item");
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toContainText("Track Charlie");

    // The removed track is gone from autoplay too: after closing the panel,
    // Next lands on Charlie rather than the removed Bravo.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await player.getByRole("button", { name: "Next track" }).click();
    await expect(player).toContainText("Track Charlie");
  });

  test("drag-reordering an upcoming track changes the order", async ({
    page,
  }) => {
    await setup(page);
    const { panel } = await startAndOpenQueue(page);

    // Drag Bravo's handle down past Charlie. Position the press with hover()
    // (reliable hit-testing on the handle), then drive the drag with real
    // pointermove events — dnd-kit needs them past its 6px activation distance,
    // plus a settle move at the destination so onDragOver fires before release.
    const handle = panel
      .getByTestId("queue-item")
      .filter({ hasText: "Track Bravo" })
      .getByRole("button", { name: "Reorder track" });
    const charlie = panel
      .getByTestId("queue-item")
      .filter({ hasText: "Track Charlie" });

    await handle.hover();
    await page.mouse.down();
    const to = await charlie.boundingBox();
    if (!to) throw new Error("missing Charlie bounding box");
    const targetX = to.x + to.width / 2;
    const targetY = to.y + to.height * 0.9;
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await page.mouse.move(targetX, targetY, { steps: 5 });
    await page.mouse.up();

    const items = panel.getByTestId("queue-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Track Charlie");
    await expect(items.nth(1)).toContainText("Track Bravo");
  });

  test("right-click 'Add to queue' appends the track to the end", async ({
    page,
  }) => {
    await setup(page);
    await startPlaying(page); // queue [Alpha, Bravo, Charlie]

    // Append Charlie again via its row context menu.
    await page.locator('[data-index="2"]').click({ button: "right" });
    await page.getByTestId("queue-add").click();

    await page.getByTestId("queue-trigger").click();
    const items = page.getByTestId("queue-panel").getByTestId("queue-item");
    await expect(items).toHaveCount(3); // Bravo, Charlie, + appended Charlie
    await expect(items.nth(2)).toContainText("Track Charlie");
  });

  test("right-click 'Play next' inserts after the current track", async ({
    page,
  }) => {
    await setup(page);
    await startPlaying(page); // queue [Alpha, Bravo, Charlie]

    await page.locator('[data-index="2"]').click({ button: "right" });
    await page.getByTestId("queue-play-next").click();

    await page.getByTestId("queue-trigger").click();
    const items = page.getByTestId("queue-panel").getByTestId("queue-item");
    // Charlie is now first up (inserted right after Alpha), ahead of Bravo.
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Track Charlie");
    await expect(items.nth(1)).toContainText("Track Bravo");
  });

  test("a hand-added track survives filtering (queue freezes)", async ({
    page,
  }) => {
    await setup(page);
    await startPlaying(page); // queue [Alpha, Bravo, Charlie]

    await page.locator('[data-index="2"]').click({ button: "right" });
    await page.getByTestId("queue-add").click(); // freezes the queue

    // Filter down to just Alpha. Without the freeze, the SoundCloud view would
    // reconcile "up next" to the visible list (emptying it); frozen, it holds.
    await page.getByRole("button", { name: /^filters$/i }).click();
    await page.getByPlaceholder("…").fill("alpha");
    await expect(page.locator("[data-index]")).toHaveCount(1);

    await page.getByTestId("queue-trigger").click();
    const items = page.getByTestId("queue-panel").getByTestId("queue-item");
    await expect(items).toHaveCount(3); // Bravo, Charlie, Charlie — untouched
  });
});
