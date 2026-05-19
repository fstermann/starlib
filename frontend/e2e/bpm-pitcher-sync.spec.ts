import { expect, test } from "./fixtures";

/**
 * Regression: editing the BPM in the SC library row should immediately
 * re-pitch the currently playing track. Before the fix, the pitcher kept
 * using the BPM that was seeded into the player queue at playback start.
 */

const TRACK_ID = 42;
const TRACK_URN = `soundcloud:tracks:${TRACK_ID}`;

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
            id: TRACK_ID,
            urn: TRACK_URN,
            title: "Sync me",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/sync-me",
          },
        ],
        next_href: null,
      }),
    }),
  );
  for (const url of [
    "https://api.soundcloud.com/tracks*",
    "https://api.soundcloud.com/me/playlists*",
    "https://api.soundcloud.com/me/feed/tracks*",
  ]) {
    await page.route(url, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ collection: [], next_href: null }),
      }),
    );
  }
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bpms: { [String(TRACK_ID)]: 120 } }),
    }),
  );
  await page.route("**/api/bpm/soundcloud", (route) => {
    const body = route.request().postDataJSON() as {
      track_id: number;
      bpm: number;
    };
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ track_id: body.track_id, bpm: body.bpm }),
    });
  });
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

test.describe("BPM pitcher — table sync", () => {
  test("editing the row BPM updates the pitcher's current BPM live", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    const row = page.locator("[data-index]").first();
    await expect(row).toContainText("Sync me");
    await expect(row).toContainText("120");

    // Start playback so the player has a current SC track.
    await row
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        await row.click();
      });

    const trigger = page.getByTestId("bpm-pitcher-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("120");

    // Edit the BPM in the cell: 120 → 121 via the increment + Save.
    await row.getByTestId("sc-bpm-edit-trigger").click();
    await page.getByRole("button", { name: "Increase BPM" }).click();
    await page.getByTestId("sc-bpm-save").click();

    // The cell reflects the edit and the pitcher trigger picks it up live —
    // the regression is the trigger sticking at 120.
    await expect(row).toContainText("121");
    await expect(trigger).toContainText("121");
  });
});
