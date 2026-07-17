import { expect, test } from "./fixtures";

/**
 * SoundCloud library BPM range filter.
 *
 * BPM for SoundCloud tracks lives in the backend cache (analysed / manually
 * set), not on the track object — so the filter reads the bulk BPM prefill.
 * Tracks with no known BPM are dropped by default and kept only when the
 * "Include unknown BPM" toggle is on.
 */

const TRACKS = [
  { id: 42, title: "Track A120", bpm: 120 },
  { id: 99, title: "Track B124", bpm: 124 },
  { id: 7, title: "Track C130", bpm: 130 },
  { id: 5, title: "Track D-unknown", bpm: null }, // never analysed
];

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
        collection: TRACKS.map((t) => ({
          id: t.id,
          urn: `soundcloud:tracks:${t.id}`,
          title: t.title,
          user: { id: 1, username: "me" },
          duration: 200_000,
          permalink_url: `https://soundcloud.com/me/${t.id}`,
        })),
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
  // Cached BPMs for the three analysed tracks; id 5 is absent (unknown).
  await page.route("**/api/bpm/soundcloud/bulk", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bpms: Object.fromEntries(
          TRACKS.filter((t) => t.bpm != null).map((t) => [
            String(t.id),
            t.bpm,
          ]),
        ),
      }),
    }),
  );
}

test.describe("soundcloud BPM filter", () => {
  test("BPM control and unknown toggle render once BPMs are known", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(4, {
      timeout: 5000,
    });

    await page.getByRole("button", { name: /^filters$/i }).click();
    // The "Include unknown BPM" toggle only renders once the source tracks
    // yield a real BPM range, so its presence proves the BPM filter surface.
    await expect(
      page.getByRole("checkbox", { name: "Include unknown BPM" }),
    ).toBeVisible();
  });

  test("range excludes tracks outside it and unknown BPM by default", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud&bpmMin=123&bpmMax=127");

    // Only the 124 BPM track survives: 120 and 130 are out of range, and the
    // unknown-BPM track is dropped because the include toggle is off.
    await expect(page.locator("[data-index]")).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(page.getByText("Track B124")).toBeVisible();
    await expect(page.getByText("Track A120")).toHaveCount(0);
    await expect(page.getByText("Track C130")).toHaveCount(0);
    await expect(page.getByText("Track D-unknown")).toHaveCount(0);
  });

  test("include-unknown toggle keeps un-analysed tracks in range", async ({
    page,
  }) => {
    await setup(page);
    await page.goto(
      "/library?source=soundcloud&bpmMin=123&bpmMax=127&bpm_include_unknown=true",
    );

    // The 124 track plus the unknown-BPM track; 120 and 130 stay excluded.
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });
    await expect(page.getByText("Track B124")).toBeVisible();
    await expect(page.getByText("Track D-unknown")).toBeVisible();
    await expect(page.getByText("Track A120")).toHaveCount(0);
    await expect(page.getByText("Track C130")).toHaveCount(0);
  });
});
