import { expect, test } from "./fixtures";

/**
 * SoundCloud table renders Uploaded and Posted columns. Uploaded sorts by
 * upload date (created_at); Posted sorts by the feed activity timestamp
 * (addedAt) — when the track was posted/reposted into the feed. The fixture
 * gives each track an addedAt that is inverted relative to created_at so the
 * two sorts produce different orders, proving Posted keys off addedAt.
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
            id: 1,
            urn: "soundcloud:tracks:1",
            title: "Older track",
            user: { id: 1, username: "me" },
            duration: 200_000,
            // Uploaded first, posted to feed most recently.
            created_at: "2023-01-15T00:00:00Z",
            addedAt: "2024-12-01T00:00:00Z",
            permalink_url: "https://soundcloud.com/me/older",
          },
          {
            id: 2,
            urn: "soundcloud:tracks:2",
            title: "Newer track",
            user: { id: 1, username: "me" },
            duration: 200_000,
            // Uploaded most recently, posted to feed earliest.
            created_at: "2024-06-01T00:00:00Z",
            addedAt: "2023-05-01T00:00:00Z",
            permalink_url: "https://soundcloud.com/me/newer",
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

test.describe("SoundCloud date columns", () => {
  test("Uploaded and Posted columns render and each sorts by its own date", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");

    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    const header = page.getByRole("row").first();
    await expect(header.getByText("Uploaded", { exact: true })).toBeVisible();
    await expect(header.getByText("Posted", { exact: true })).toBeVisible();

    // Default order matches the API response: Older then Newer.
    await expect(page.locator('[data-index="0"]')).toContainText("Older track");
    await expect(page.locator('[data-index="1"]')).toContainText("Newer track");

    // Sort by Uploaded ascending → Older (2023) first.
    await header.locator("button", { hasText: "Uploaded" }).click();
    await expect(page.locator('[data-index="0"]')).toContainText("Older track");
    await expect(page.locator('[data-index="1"]')).toContainText("Newer track");

    // Toggle to descending → Newer first.
    await header.locator("button", { hasText: "Uploaded" }).click();
    await expect(page.locator('[data-index="0"]')).toContainText("Newer track");
    await expect(page.locator('[data-index="1"]')).toContainText("Older track");

    // Sort by Posted ascending → earliest addedAt first. "Newer track" was
    // posted in 2023, "Older track" in 2024, so the order flips relative to
    // Uploaded — proving Posted keys off addedAt, not created_at.
    await header.locator("button", { hasText: "Posted" }).click();
    await expect(page.locator('[data-index="0"]')).toContainText("Newer track");
    await expect(page.locator('[data-index="1"]')).toContainText("Older track");

    // Toggle Posted descending → latest addedAt first.
    await header.locator("button", { hasText: "Posted" }).click();
    await expect(page.locator('[data-index="0"]')).toContainText("Older track");
    await expect(page.locator('[data-index="1"]')).toContainText("Newer track");
  });
});
