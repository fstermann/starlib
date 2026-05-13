import { expect, test } from "./fixtures";

/**
 * SC view BPM cell: manual override via popover.
 *
 * Reanalyze is gated on the Tauri WebView (analyzeSc uses tauri invoke),
 * so we cover only the manual edit path here. The popover trigger and
 * Save button are reachable in the browser fixture; the Reanalyze button
 * is hidden when isTauri() is false.
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
            title: "Edit me",
            user: { id: 1, username: "me" },
            duration: 200_000,
            permalink_url: "https://soundcloud.com/me/edit-me",
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
  // Track already has a cached BPM of 120 so the cell renders as a popover
  // trigger (rather than the "Detect" icon-only button).
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bpms: { [String(TRACK_ID)]: 120 } }),
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

test.describe("SC view — BPM edit popover", () => {
  test("manual override saves to backend and updates the row", async ({
    page,
  }) => {
    await setup(page);

    let lastSavedBpm: number | null = null;
    await page.route("**/api/bpm/soundcloud", (route) => {
      const req = route.request();
      const body = req.postDataJSON() as { track_id: number; bpm: number };
      lastSavedBpm = body.bpm;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ track_id: body.track_id, bpm: body.bpm }),
      });
    });

    await page.goto("/library?source=soundcloud");

    const row = page.locator("[data-index]").first();
    await expect(row).toContainText("Edit me");
    await expect(row).toContainText("120");

    // Open the popover from the BPM cell.
    await row.getByTestId("sc-bpm-edit-trigger").click();
    await expect(page.getByTestId("sc-bpm-edit-input")).toBeVisible();

    // react-aria-components NumberField commits on Enter/blur. Click the
    // increment button so the field state ticks 120 → 121 without having
    // to negotiate keyboard formatting locale rules.
    await page.getByRole("button", { name: "Increase BPM" }).click();
    await page.getByTestId("sc-bpm-save").click();

    // Backend was called with the override (120 + 1 increment = 121).
    await expect.poll(() => lastSavedBpm).toBe(121);

    // Row reflects the new value (popover closes; cell shows 121).
    await expect(row).toContainText("121");
  });
});
