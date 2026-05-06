import { expect, test } from "./fixtures";

/**
 * Bugfix: when the current track is flagged unplayable (SoundCloud refused
 * to stream after a 403, or it was already in the session-scoped unplayable
 * set), the player should auto-advance to the next queued track instead of
 * sitting on a dead source.
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

test.describe("autoskip unplayable tracks", () => {
  test("flagging the current track unplayable advances the queue", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    // Wait for the likes table to render both rows.
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    // Start playing Alpha (queues both tracks; Alpha is the current track).
    await page
      .locator('[data-index="0"]')
      .getByRole("button", { name: /play/i })
      .first()
      .click()
      .catch(async () => {
        // If there's no per-row play button, fall back to clicking the row's
        // title to load it into the player.
        await page.locator('[data-index="0"]').click();
      });

    // Wait until the unplayable api is exposed on window — guarantees the
    // sc-unplayable module has been imported by the page.
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __starlibScUnplayable?: unknown })
          .__starlibScUnplayable === "object",
    );

    // Capture which track the player is currently focused on. The waveform
    // player surfaces the current title in its title row.
    const player = page.getByTestId("waveform-player");
    await expect(player).toBeVisible();
    await expect(player).toContainText("Alpha track");

    // Mark Alpha unplayable — same call the player makes after a double-403.
    await page.evaluate(() => {
      const api = (
        window as unknown as {
          __starlibScUnplayable: { markScUnplayable: (id: number) => void };
        }
      ).__starlibScUnplayable;
      api.markScUnplayable(42);
    });

    // The auto-skip effect should advance the queue to Bravo.
    await expect(player).toContainText("Bravo track");
    await expect(player).not.toContainText("Alpha track");
  });
});
