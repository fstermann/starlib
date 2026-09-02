import { expect, test } from "./fixtures";

/**
 * #382: when a SoundCloud track has no `download_url`, parse the description
 * for a known fallback platform link (bandcamp / beatport / hypeddit) and
 * surface it through the download icon.
 *
 * The download and store-search icons are each collapsed into a single icon:
 * one link opens directly, multiple links open a popover selector.
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
          {
            id: 400,
            urn: "soundcloud:tracks:400",
            title: "Download and description link",
            user: { id: 1, username: "me" },
            duration: 180_000,
            created_at: "2024-04-01T00:00:00Z",
            permalink_url: "https://soundcloud.com/me/both",
            download_url:
              "https://api.soundcloud.com/tracks/400/download?direct=1",
            description:
              "Also grab it on Beatport: https://www.beatport.com/track/x/123",
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

test.describe("SoundCloud download & search links", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(4, {
      timeout: 5000,
    });
  });

  test("single download link opens directly (no popover)", async ({ page }) => {
    // Direct download → the download icon is a plain link to download_url.
    const directRow = page.locator('[data-index="0"]');
    const download = directRow.locator('[data-testid="sc-download"]');
    await expect(download).toHaveAttribute(
      "href",
      "https://api.soundcloud.com/tracks/100/download?direct=1",
    );

    // Bandcamp track has no download_url but the description gives us a link.
    const bandcampRow = page.locator('[data-index="1"]');
    await expect(
      bandcampRow.locator('[data-testid="sc-download"]'),
    ).toHaveAttribute("href", "https://artist.bandcamp.com/track/the-song");

    // No download and no description link → no download icon at all.
    const emptyRow = page.locator('[data-index="2"]');
    await expect(emptyRow.locator('[data-testid="sc-download"]')).toHaveCount(
      0,
    );
  });

  test("two download links open a popover with both options", async ({
    page,
  }) => {
    const bothRow = page.locator('[data-index="3"]');
    // With two links the trigger is a button, not an anchor.
    const trigger = bothRow.locator('[data-testid="sc-download"]');
    await expect(trigger).toHaveCount(1);
    await trigger.click();

    const options = page.locator('[data-testid="sc-download-option"]');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveAttribute(
      "href",
      "https://api.soundcloud.com/tracks/400/download?direct=1",
    );
    await expect(options.nth(1)).toHaveAttribute(
      "href",
      "https://www.beatport.com/track/x/123",
    );
  });

  test("store search opens a popover with Bandcamp and Beatport", async ({
    page,
  }) => {
    const directRow = page.locator('[data-index="0"]');
    await directRow.locator('[data-testid="sc-search"]').click();

    const options = page.locator('[data-testid="sc-search-option"]');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveAttribute(
      "href",
      /bandcamp\.com\/search\?q=/,
    );
    await expect(options.nth(1)).toHaveAttribute(
      "href",
      /beatport\.com\/search\?q=/,
    );
  });
});
