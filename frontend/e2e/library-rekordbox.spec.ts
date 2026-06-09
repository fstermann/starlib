import type { Route } from "@playwright/test";

import { expect, test } from "./fixtures";

const PLAYLISTS = [
  {
    id: "root-folder",
    name: "DJ Sets",
    parent_id: null,
    is_folder: true,
    is_smart: false,
    track_count: 0,
  },
  {
    id: "pl-1",
    name: "Sunday Mix",
    parent_id: null,
    is_folder: false,
    is_smart: false,
    track_count: 2,
  },
  {
    id: "smart-1",
    name: "Recent 148+",
    parent_id: null,
    is_folder: false,
    is_smart: true,
    track_count: 5,
  },
];

const TRACKS = [
  {
    id: "t-1",
    title: "Foo",
    artist: "Bar",
    album: null,
    genre: "House",
    bpm: 124.5,
    key: "8A",
    duration_seconds: 350,
    file_path: "/music/foo.flac",
    comment: "sc:12345",
    soundcloud_id: 12345,
    date_added: "2024-01-15",
    release_date: "2023-11-03",
    has_artwork: true,
    has_waveform: true,
  },
  {
    id: "t-2",
    title: "Baz",
    artist: "Qux",
    album: null,
    genre: "Techno",
    bpm: 130,
    key: "10A",
    duration_seconds: 410,
    file_path: "/music/baz.flac",
    comment: null,
    soundcloud_id: null,
    date_added: "2024-02-20",
    release_date: null,
    has_artwork: false,
    has_waveform: false,
  },
];

// Minimal 1×1 transparent JPEG (just enough for the <img> tag to load without
// erroring during the test — we don't decode the image).
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
// 7200-byte PWV4 payload (1200 cols × 6 bytes). Zeros are fine — the canvas
// just paints nothing and the test only needs the fetch to resolve cleanly.
const WAVEFORM_BYTES = Buffer.alloc(7200);

function jsonRoute(body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

test.describe("Library: Rekordbox source", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      "**/api/rekordbox/status",
      jsonRoute({ available: true, reason: null }),
    );
    await page.route(
      "**/api/rekordbox/playlists",
      jsonRoute({ playlists: PLAYLISTS }),
    );
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks",
      jsonRoute({ tracks: TRACKS }),
    );
    await page.route("**/api/rekordbox/tracks/*/artwork*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: TINY_JPEG,
      }),
    );
    await page.route("**/api/rekordbox/tracks/*/waveform", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: WAVEFORM_BYTES,
      }),
    );
  });

  test("shows playlists and tracks", async ({ page }) => {
    await page.goto("/library?source=rekordbox");

    await expect(page.getByText("DJ Sets")).toBeVisible();
    const sundayMix = page.getByText("Sunday Mix");
    await expect(sundayMix).toBeVisible();
    // Smart playlist surfaces with its track count alongside static ones.
    await expect(page.getByText("Recent 148+")).toBeVisible();

    await sundayMix.click();

    const tracks = page.getByTestId("rekordbox-tracks");
    // Use exact matches — the table mounts a dnd-kit accessibility announcer
    // ("press the space bar to lift...") inside the same testid container, so
    // loose substring matches would also pick up the announcer's text.
    await expect(tracks.getByText("Foo", { exact: true })).toBeVisible();
    await expect(tracks.getByText("Bar", { exact: true })).toBeVisible();
    await expect(tracks.getByText("Baz", { exact: true })).toBeVisible();
    // SoundCloud id from the comment field is surfaced.
    await expect(tracks.getByText("12345", { exact: true })).toBeVisible();
    // Duration formatted as m:ss
    await expect(tracks.getByText("5:50", { exact: true })).toBeVisible();
    await expect(tracks.getByText("6:50", { exact: true })).toBeVisible();

    // Added / Released columns surface the parsed dates.
    await expect(tracks.getByText("2024-01-15", { exact: true })).toBeVisible();
    await expect(tracks.getByText("2023-11-03", { exact: true })).toBeVisible();

    // Cover for the track that has artwork is fetched from the rekordbox
    // artwork endpoint and rendered inline.
    const cover = tracks.locator(
      `img[src*="/api/rekordbox/tracks/t-1/artwork"]`,
    );
    await expect(cover).toBeVisible();

    await expect(page).toHaveURL(/playlist=pl-1/);
  });

  test("renders unavailable state when the master db is missing", async ({
    page,
  }) => {
    await page.route(
      "**/api/rekordbox/status",
      jsonRoute({ available: false, reason: "Rekordbox not installed" }),
    );
    await page.goto("/library?source=rekordbox");
    await expect(page.getByText("Rekordbox isn't available")).toBeVisible();
    await expect(page.getByText("Rekordbox not installed")).toBeVisible();
  });
});
