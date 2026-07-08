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
  },
];

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
    await expect(tracks.getByText("Foo")).toBeVisible();
    await expect(tracks.getByText("Bar")).toBeVisible();
    await expect(tracks.getByText("Baz")).toBeVisible();
    // SoundCloud id from the comment field is surfaced.
    await expect(tracks.getByText("12345")).toBeVisible();
    // Duration formatted as m:ss
    await expect(tracks.getByText("5:50")).toBeVisible();
    await expect(tracks.getByText("6:50")).toBeVisible();

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
