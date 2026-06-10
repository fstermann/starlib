import { expect, test } from "./fixtures";

/**
 * #382: when a SoundCloud track has no `download_url`, parse the description
 * for a known fallback platform link (bandcamp / beatport / hypeddit) and
 * surface it through the existing download icon slot.
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
            id: 100,
            urn: "soundcloud:tracks:100",
            title: "Direct download",
            user: { id: 1, username: "me" },
            duration: 200_000,
            created_at: "2024-01-01T00:00:00Z",
            permalink_url: "https://soundcloud.com/me/direct",
            download_url:
              "https://api.soundcloud.com/tracks/100/download?direct=1",
            description: null,
          },
          {
            id: 200,
            urn: "soundcloud:tracks:200",
            title: "Bandcamp fallback",
            user: { id: 1, username: "me" },
            duration: 180_000,
            created_at: "2024-02-01T00:00:00Z",
            permalink_url: "https://soundcloud.com/me/bandcamp",
            download_url: null,
            description:
              "Out now on Bandcamp: https://artist.bandcamp.com/track/the-song",
          },
          {
            id: 300,
            urn: "soundcloud:tracks:300",
            title: "No fallback either",
            user: { id: 1, username: "me" },
            duration: 180_000,
            created_at: "2024-03-01T00:00:00Z",
            permalink_url: "https://soundcloud.com/me/none",
            download_url: null,
            description: "Just some text, no link here.",
          },
        ],
        next_href: null,
      }),
    }),
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
}

test.describe("SoundCloud fallback download", () => {
  test("renders parsed description link when download_url is missing", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    await expect(page.locator("[data-index]")).toHaveCount(3, {
      timeout: 5000,
    });

    // Track with direct download → uses the standard download icon, not the fallback.
    const directRow = page.locator('[data-index="0"]');
    await expect(
      directRow.locator('[data-testid="sc-download-link"]'),
    ).toHaveCount(1);
    await expect(
      directRow.locator('[data-testid="sc-download-fallback"]'),
    ).toHaveCount(0);

    // Bandcamp track has no download_url but the description gives us a link.
    const bandcampRow = page.locator('[data-index="1"]');
    const fallback = bandcampRow.locator(
      '[data-testid="sc-download-fallback"]',
    );
    await expect(fallback).toHaveCount(1);
    await expect(fallback).toHaveAttribute(
      "href",
      "https://artist.bandcamp.com/track/the-song",
    );
    await expect(fallback.locator("img")).toHaveAttribute("alt", "Bandcamp");

    // Track with no download and no description link → empty slot, no link.
    const emptyRow = page.locator('[data-index="2"]');
    await expect(
      emptyRow.locator('[data-testid="sc-download-fallback"]'),
    ).toHaveCount(0);
    await expect(
      emptyRow.locator('[data-testid="sc-download-link"]'),
    ).toHaveCount(0);
  });
});
