import type { Route } from "@playwright/test";

import { expect, test } from "./fixtures";

const TRACK = {
  id: "t-1",
  title: "Foo",
  artist: "Bar",
  album: null,
  genre: "House",
  bpm: 124,
  key: "8A",
  duration_seconds: 350,
  file_path: "/music/foo.flac",
  comment: null,
  soundcloud_id: null,
  date_added: "2024-01-15",
  release_date: null,
  has_artwork: false,
  has_waveform: false,
};

function jsonRoute(body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

test.describe("Library rows: Rekordbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      "**/api/rekordbox/status",
      jsonRoute({ available: true, reason: null }),
    );
    await page.route(
      "**/api/rekordbox/playlists",
      jsonRoute({
        playlists: [
          {
            id: "pl-1",
            name: "Sunday Mix",
            parent_id: null,
            is_folder: false,
            is_smart: false,
            track_count: 1,
          },
        ],
      }),
    );
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks",
      jsonRoute({ tracks: [TRACK] }),
    );
  });

  test("the settings toggle switches library rows to compact", async ({
    page,
  }) => {
    await page.goto("/library?source=rekordbox&playlist=pl-1");
    const row = page
      .getByTestId("rekordbox-tracks")
      .locator('[data-index="0"]');
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.height).toBe(40);

    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Library" }).click();
    const density = dialog.getByTestId("settings-row-density");
    await density.getByRole("radio", { name: "Compact" }).click();
    await page.keyboard.press("Escape");

    await expect.poll(async () => (await row.boundingBox())!.height).toBe(32);

    // The setting persists across reloads.
    await page.reload();
    await expect
      .poll(async () => (await row.boundingBox())?.height ?? 0)
      .toBe(32);
  });

  test("dense rows shrink library rows to 24px", async ({ page }) => {
    await page.goto("/library?source=rekordbox&playlist=pl-1");
    const row = page
      .getByTestId("rekordbox-tracks")
      .locator('[data-index="0"]');
    await expect(row).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Library" }).click();
    await dialog
      .getByTestId("settings-row-density")
      .getByRole("radio", { name: "Dense" })
      .click();
    await page.keyboard.press("Escape");

    await expect.poll(async () => (await row.boundingBox())!.height).toBe(24);
  });
});

const FILE = {
  file_path: "alpha.flac",
  file_name: "alpha.flac",
  file_size: 20 * 1024 * 1024,
  file_format: ".flac",
  has_artwork: false,
  title: "Alpha",
  artist: "Alpha",
  duration: 245,
};

test.describe("Library rows: Filesystem", () => {
  test.beforeEach(async ({ page }) => {
    const browse = jsonRoute({
      items: [FILE],
      total: 1,
      page: 1,
      size: 50,
      pages: 1,
    });
    await page.route("**/api/metadata/folders/*/browse*", browse);
    await page.route(/\/api\/metadata\/folders\/browse-path\?/, browse);
    await page.route(
      "**/api/metadata/files/*/peaks*",
      jsonRoute({ peaks: Array(60).fill(0.5) }),
    );
  });

  test("compact rows apply to the filesystem table", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "starlib_ui",
        JSON.stringify({ rowDensity: "compact" }),
      );
    });
    await page.goto("/library");
    const row = page.locator('[data-index="0"] [role="row"]');
    await expect(row).toBeVisible();
    await expect.poll(async () => (await row.boundingBox())!.height).toBe(32);
  });

  test("dense rows apply to the filesystem table", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "starlib_ui",
        JSON.stringify({ rowDensity: "dense" }),
      );
    });
    await page.goto("/library");
    const row = page.locator('[data-index="0"] [role="row"]');
    await expect(row).toBeVisible();
    await expect.poll(async () => (await row.boundingBox())!.height).toBe(24);
  });

  test("the row waveform resizes from its header", async ({ page }) => {
    await page.goto("/library");
    const waveform = page.getByRole("img", { name: "Waveform for Alpha" });
    await expect(waveform).toBeVisible();
    const before = (await waveform.boundingBox())!.width;

    const handle = page
      .getByTestId("waveform-header")
      .locator('[title^="Drag to resize"]');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect
      .poll(async () => (await waveform.boundingBox())!.width)
      .toBeGreaterThan(before + 40);
  });
});

test.describe("Library rows: SoundCloud", () => {
  test("compact rows apply to the SoundCloud table", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("access_token", "fake-token");
      window.localStorage.setItem(
        "token_expires_at",
        String(Date.now() + 60 * 60 * 1000),
      );
      window.localStorage.setItem(
        "sc_user",
        JSON.stringify({ id: 1, username: "me", permalink: "me" }),
      );
      window.localStorage.setItem(
        "starlib_ui",
        JSON.stringify({ rowDensity: "compact" }),
      );
    });
    await page.route(
      "https://api.soundcloud.com/me/likes/tracks*",
      jsonRoute({
        collection: [
          {
            id: 42,
            urn: "soundcloud:tracks:42",
            title: "Liked track",
            user: { id: 1, username: "me" },
            duration: 200_000,
          },
        ],
        next_href: null,
      }),
    );
    for (const url of [
      "https://api.soundcloud.com/tracks*",
      "https://api.soundcloud.com/me/playlists*",
      "https://api.soundcloud.com/me/feed/tracks*",
    ]) {
      await page.route(url, jsonRoute({ collection: [], next_href: null }));
    }
    await page.route(
      "**/api/metadata/collection/soundcloud-ids",
      jsonRoute([]),
    );
    await page.route("**/api/bpm/soundcloud/bulk", jsonRoute({ bpms: {} }));

    await page.goto("/library?source=soundcloud");
    const row = page.locator('[data-index="0"] [role="row"]');
    await expect(row).toContainText("Liked track");
    await expect.poll(async () => (await row.boundingBox())!.height).toBe(32);
  });
});
