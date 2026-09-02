import { expect, test } from "./fixtures";

/**
 * The SoundCloud table exposes the full set of API metadata fields as
 * opt-in columns. They are hidden by default; enabling one via the Columns
 * menu renders its values and (where sortable) sorts by them.
 */

const TRACK_A = {
  id: 1,
  urn: "soundcloud:tracks:1",
  title: "Alpha track",
  user: { id: 1, username: "me" },
  duration: 200_000,
  created_at: "2023-01-15T00:00:00Z",
  permalink_url: "https://soundcloud.com/me/alpha",
  key_signature: "Amin",
  label_name: "Alpha Records",
  tag_list: 'techno "deep house" 909',
  release_year: 2021,
  release_month: 3,
  release_day: 7,
  favoritings_count: 4200,
  reposts_count: 12,
  comment_count: 3,
  download_count: 55,
  user_playback_count: 9,
  isrc: "USAB12300001",
  license: "cc-by-nc",
  access: "playable",
  sharing: "public",
  metadata_artist: "Alpha Feat. Beta",
  downloadable: true,
  description: "First line\nSecond line",
};

const TRACK_B = {
  id: 2,
  urn: "soundcloud:tracks:2",
  title: "Bravo track",
  user: { id: 1, username: "me" },
  duration: 200_000,
  created_at: "2024-06-01T00:00:00Z",
  permalink_url: "https://soundcloud.com/me/bravo",
  key_signature: "Cmaj",
  label_name: "Bravo Tapes",
  release_year: 2019,
  favoritings_count: 7,
  sharing: "public",
};

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
        collection: [TRACK_A, TRACK_B],
        next_href: null,
      }),
    }),
  );
  for (const url of [
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
      body: JSON.stringify({ bpms: {} }),
    }),
  );
}

/** Enable columns by label via the Columns dropdown. */
async function showColumns(
  page: import("@playwright/test").Page,
  ...labels: string[]
) {
  await page.getByRole("button", { name: "Columns" }).click();
  for (const label of labels) {
    await page
      .getByRole("menuitemcheckbox", { name: label, exact: true })
      .click();
  }
  await page.keyboard.press("Escape");
}

function cell(
  page: import("@playwright/test").Page,
  row: number,
  columnId: string,
) {
  return page.locator(`[data-index="${row}"] [data-column-id="${columnId}"]`);
}

test.describe("SoundCloud metadata columns", () => {
  test("extended columns are hidden by default", async ({ page }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    for (const id of ["key_signature", "label_name", "isrc", "description"]) {
      await expect(page.locator(`[data-column-id="${id}"]`)).toHaveCount(0);
    }
  });

  test("enabling columns renders their API values", async ({ page }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    await showColumns(
      page,
      "Key",
      "Label",
      "Tags",
      "Released",
      "Likes",
      "ISRC",
      "License",
      "Metadata artist",
      "Description",
    );

    await expect(cell(page, 0, "key_signature")).toHaveText("Amin");
    await expect(cell(page, 0, "label_name")).toHaveText("Alpha Records");
    // tag_list is space-separated with quotes around multi-word tags.
    await expect(cell(page, 0, "tag_list")).toHaveText(
      "techno, deep house, 909",
    );
    // release_year/month/day → DD.MM.YYYY.
    await expect(cell(page, 0, "released")).toHaveText("07.03.2021");
    await expect(cell(page, 0, "favoritings_count")).toHaveText("4.2K");
    await expect(cell(page, 0, "isrc")).toHaveText("USAB12300001");
    await expect(cell(page, 0, "license")).toHaveText("cc-by-nc");
    await expect(cell(page, 0, "metadata_artist")).toHaveText(
      "Alpha Feat. Beta",
    );
    // Newlines collapse so the row stays single-line.
    await expect(cell(page, 0, "description")).toHaveText(
      "First line Second line",
    );

    // Missing fields fall back to an em-dash rather than rendering empty.
    await expect(cell(page, 1, "isrc")).toHaveText("—");
    await expect(cell(page, 1, "metadata_artist")).toHaveText("—");
    // Year-only release date renders just the year.
    await expect(cell(page, 1, "released")).toHaveText("2019");
  });

  test("Likes column sorts by favoritings_count", async ({ page }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    await showColumns(page, "Likes");

    const header = page.getByRole("row").first();
    // Ascending → Bravo (7) before Alpha (4200).
    await header.locator("button", { hasText: "Likes" }).click();
    await expect(page.locator('[data-index="0"]')).toContainText("Bravo track");

    // Descending → Alpha first.
    await header.locator("button", { hasText: "Likes" }).click();
    await expect(page.locator('[data-index="0"]')).toContainText("Alpha track");
  });
});
