import type { Locator, Page, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

function track(
  id: string,
  title: string,
  key: string,
  bpm: number,
  genre = "Techno",
) {
  return {
    id,
    title,
    artist: "Artist",
    album: null,
    genre,
    bpm,
    key,
    duration_seconds: 300,
    file_path: `/music/${id}.flac`,
    comment: null,
    soundcloud_id: null,
    date_added: null,
    release_date: null,
    has_artwork: false,
    has_waveform: false,
    entry_id: `e-${id}`,
  };
}

// Source: 8A at 130. Unpitched, the default BPM range is 125–135.
const SOURCE = track("src", "Source Tune", "8A", 130);
const IN_PLAYLIST_MATCH = track("pl-match", "Playlist Neighbour", "9A", 130);
const IN_PLAYLIST_CLASH = track("pl-clash", "Playlist Clash", "3B", 130);
const SAME_KEY = track("same", "Same Key", "8A", 129.5);
// 1A pitched up ~0.49 st to 130 lands on 8A, but half a semitone off.
const DETUNED = track("detuned", "Detuned Tune", "1A", 126.2);
const OTHER_GENRE = track("genre", "House Tune", "8A", 130, "House");
const BOOST = track("boost", "Boost Tune", "10A", 130);
// 1A at 122.7 sounds as 8A once pitched to 130; outside the default range.
const SLOW = track("slow", "Slow Tune", "1A", 122.7);
// 3A at 137 matches the source when both play at 138 (source shifts to 3A).
const FAST = track("fast", "Fast Tune", "3A", 137);

const PLAYLIST = [SOURCE, IN_PLAYLIST_MATCH, IN_PLAYLIST_CLASH];
const COLLECTION = [
  ...PLAYLIST,
  SAME_KEY,
  DETUNED,
  OTHER_GENRE,
  BOOST,
  SLOW,
  FAST,
];

function jsonRoute(body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

async function mockRekordbox(page: Page) {
  let playlistTracks = [...PLAYLIST];
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
          track_count: PLAYLIST.length,
        },
        {
          id: "pl-2",
          name: "Warmup",
          parent_id: null,
          is_folder: false,
          is_smart: false,
          track_count: 0,
        },
      ],
    }),
  );
  await page.route("**/api/rekordbox/playlists/pl-1/order", (route) => {
    const { entry_ids } = route.request().postDataJSON() as {
      entry_ids: string[];
    };
    playlistTracks = entry_ids.map((id) =>
      playlistTracks.find((t) => t.entry_id === id)!,
    );
    return jsonRoute({ tracks: playlistTracks })(route);
  });
  await page.route(
    "**/api/rekordbox/playlists/pl-2/tracks",
    jsonRoute({ tracks: [SAME_KEY] }),
  );
  await page.route("**/api/rekordbox/playlists/pl-1/tracks", (route) => {
    if (route.request().method() === "POST") {
      const { track_ids } = route.request().postDataJSON() as {
        track_ids: string[];
      };
      playlistTracks = [
        ...playlistTracks,
        ...COLLECTION.filter((t) => track_ids.includes(t.id)),
      ];
    }
    return jsonRoute({ tracks: playlistTracks })(route);
  });
  await page.route(
    "**/api/rekordbox/tracks",
    jsonRoute({ tracks: COLLECTION }),
  );
}

async function openForSource(page: Page) {
  await page.goto("/library?source=rekordbox&playlist=pl-1");
  const tracks = page.getByTestId("rekordbox-tracks");
  await tracks.getByText("Source Tune", { exact: true }).click({
    button: "right",
  });
  await page.getByTestId("rekordbox-matching-tracks").click();
  const panel = page.getByTestId("matching-tracks-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("matching-tracks-source")).toContainText(
    "Source Tune",
  );
  return panel;
}

/** Drags with the mouse in steps so dnd-kit's pointer sensor activates. */
async function dragTo(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 10, start.y + 10, { steps: 5 });
  await expect(page.getByTestId("track-drag-overlay")).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 10 });
}

/** A point in the upper or lower half of a playlist row's title. */
async function rowPoint(page: Page, title: string, half: "upper" | "lower") {
  const box = (await page
    .getByTestId("rekordbox-tracks")
    .getByText(title, { exact: true })
    .boundingBox())!;
  return {
    x: box.x + box.width / 2,
    y: half === "upper" ? box.y + 1 : box.y + box.height - 1,
  };
}

function playlistTitles(page: Page) {
  return page
    .getByTestId("rekordbox-tracks")
    .locator("[data-index] span.font-medium");
}

function resultTitles(page: Page) {
  return page.getByTestId("matching-track").locator("div.truncate.font-medium");
}

test.describe("Matching tracks panel", () => {
  test.beforeEach(async ({ page }) => {
    await mockRekordbox(page);
  });

  test("lists harmonic matches with playlist tracks pinned on top", async ({
    page,
  }) => {
    await openForSource(page);

    await expect(resultTitles(page)).toHaveText([
      "Playlist Neighbour",
      "House Tune",
      "Same Key",
      "Detuned Tune",
    ]);
    await expect(page.getByTestId("matching-group-header")).toHaveText([
      "In Sunday Mix",
      "Other tracks",
    ]);
    await expect(page.getByTestId("matching-count")).toHaveText("4 matches");
    await expect(page.getByTestId("matching-genre")).toHaveText("Any genre");
    await expect(
      page.locator(
        '[data-track-id="detuned"] [data-testid="matching-detuned"]',
      ),
    ).toBeVisible();
    await expect(
      page.locator('[data-track-id="same"] [data-testid="matching-detuned"]'),
    ).toHaveCount(0);

    // Reopening reuses the cached data and still lists the results.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("matching-tracks-panel")).toBeHidden();
    await page
      .getByTestId("rekordbox-tracks")
      .getByText("Source Tune", { exact: true })
      .click({ button: "right" });
    await page.getByTestId("rekordbox-matching-tracks").click();
    await expect(resultTitles(page)).toHaveText([
      "Playlist Neighbour",
      "House Tune",
      "Same Key",
      "Detuned Tune",
    ]);
  });

  test("key rules, BPM range and scope narrow or widen the results", async ({
    page,
  }) => {
    await openForSource(page);

    await page.getByTestId("matching-rule-boost2").click();
    await expect(page.locator('[data-track-id="boost"]')).toHaveAttribute(
      "data-rule",
      "boost2",
    );

    // Widen the range: the slow 1A track is pitched up to sound as 8A.
    await page.getByTestId("matching-bpm-min").fill("120");
    await page.getByTestId("matching-bpm-min").blur();
    const slow = page.locator('[data-track-id="slow"]');
    await expect(slow).toHaveAttribute("data-rule", "same");
    await expect(slow.getByTestId("matching-heard-key")).toHaveText("8A");

    // Key lock: no pitching, so 1A no longer matches 8A.
    await page.getByTestId("matching-key-lock").click();
    await expect(slow).toHaveCount(0);
    await page.getByTestId("matching-key-lock").click();

    // Genre narrows to the picked genres.
    await expect(page.locator('[data-track-id="genre"]')).toBeVisible();
    await page.getByTestId("matching-genre").click();
    await page.getByRole("checkbox", { name: /^Techno/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-track-id="genre"]')).toHaveCount(0);

    await page.getByTestId("matching-scope").click();
    await page.getByRole("option", { name: /Current playlist/ }).click();
    await expect(resultTitles(page)).toHaveText(["Playlist Neighbour"]);
    await expect(page.getByTestId("matching-group-header")).toHaveCount(0);
  });

  test("adding a match to the playlist pins it", async ({ page }) => {
    await openForSource(page);

    await page.locator('[data-track-id="same"]').click({ button: "right" });
    await page.getByTestId("matching-add-to-playlist").click();

    // Both pinned tracks sit above "Other tracks", strongest rule first.
    const rows = page.locator(
      '[data-testid="matching-track"], [data-testid="matching-group-header"]',
    );
    await expect(rows).toHaveText([
      "In Sunday Mix",
      /Same Key/,
      /Playlist Neighbour/,
      "Other tracks",
      /House Tune/,
      /Detuned Tune/,
    ]);
    await expect(
      page.getByTestId("rekordbox-tracks").getByText("Same Key", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("matches keys as heard at the master BPM", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("starlib.pitcher.targetBpm", "138");
      window.localStorage.setItem("starlib.pitcher.enabled", "1");
    });
    await openForSource(page);

    await expect(page.getByTestId("matching-tracks-source")).toContainText(
      "→ 3A at 138.0",
    );
    // Range defaults to 133–143 around the master tempo.
    await expect(resultTitles(page)).toHaveText(["Fast Tune"]);
    await expect(
      page.locator('[data-track-id="fast"] [data-testid="matching-heard-key"]'),
    ).toHaveText("3A");
  });

  test("labels a pitched key the same way the player does", async ({
    page,
  }) => {
    // At 138, the 145 BPM source shifts −0.86 st (rounds to −1) and the
    // 142 BPM candidate −0.49 st (rounds to 0). The candidate must read 6A,
    // as in the player, not 11A from summing the relative shift.
    const source = track("src", "Source Tune", "6A", 145);
    const candidate = track("phonic", "Phonic Sound", "6A", 142);
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks",
      jsonRoute({ tracks: [source] }),
    );
    await page.route(
      "**/api/rekordbox/tracks",
      jsonRoute({ tracks: [source, candidate] }),
    );
    await page.addInitScript(() => {
      window.localStorage.setItem("starlib.pitcher.targetBpm", "138");
      window.localStorage.setItem("starlib.pitcher.enabled", "1");
    });
    await openForSource(page);

    const row = page.locator('[data-track-id="phonic"]');
    await expect(row).toHaveAttribute("data-rule", "same");
    await expect(row.getByTestId("matching-heard-key")).toHaveText("6A");
    await expect(row.getByTestId("matching-detuned")).toBeVisible();
  });

  test("the player bar opens matches for the playing track", async ({
    page,
  }) => {
    await page.route(
      "**/api/metadata/files/*/peaks*",
      jsonRoute({ peaks: Array(200).fill(0.3) }),
    );
    await page.route("**/api/metadata/files/*/audio", (route) =>
      route.fulfill({ status: 200, contentType: "audio/wav", body: "" }),
    );
    await page.goto("/library?source=rekordbox&playlist=pl-1");
    await page
      .getByTestId("rekordbox-tracks")
      .getByRole("button", { name: "Play Source Tune" })
      .click();

    await page.getByTestId("matching-tracks-trigger").click();
    await expect(page.getByTestId("matching-tracks-panel")).toBeVisible();
    await expect(page.getByTestId("matching-tracks-source")).toContainText(
      "Source Tune",
    );
    await expect(resultTitles(page).first()).toHaveText("Playlist Neighbour");

    // The palette command does the same.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("matching-tracks-panel")).toBeHidden();
    await page.getByRole("button", { name: /open command palette/i }).click();
    await page
      .getByRole("dialog")
      .locator('[data-command-id="rekordbox.matching-tracks"]')
      .click();
    await expect(page.getByTestId("matching-tracks-panel")).toBeVisible();
  });

  test("drags a match into the playlist at the drop position", async ({
    page,
  }) => {
    await openForSource(page);
    const added = page.waitForRequest(
      (r) =>
        r.method() === "POST" &&
        r.url().endsWith("/api/rekordbox/playlists/pl-1/tracks"),
    );
    const ordered = page.waitForRequest((r) =>
      r.url().endsWith("/api/rekordbox/playlists/pl-1/order"),
    );

    await dragTo(
      page,
      page.locator('[data-track-id="same"]'),
      await rowPoint(page, "Playlist Clash", "upper"),
    );
    await expect(page.getByTestId("playlist-insert-line")).toBeVisible();
    await page.mouse.up();

    expect((await added).postDataJSON()).toEqual({ track_ids: ["same"] });
    expect((await ordered).postDataJSON()).toEqual({
      entry_ids: ["e-src", "e-pl-match", "e-same", "e-pl-clash"],
    });
    await expect(playlistTitles(page)).toHaveText([
      "Source Tune",
      "Playlist Neighbour",
      "Same Key",
      "Playlist Clash",
    ]);
    // Now in the playlist, the match moves up into the pinned group.
    await expect(
      page.locator(
        '[data-testid="matching-track"], [data-testid="matching-group-header"]',
      ),
    ).toHaveText([
      "In Sunday Mix",
      /Same Key/,
      /Playlist Neighbour/,
      "Other tracks",
      /House Tune/,
      /Detuned Tune/,
    ]);
  });

  test("dragging a match already in the playlist moves it", async ({
    page,
  }) => {
    await openForSource(page);
    let posted = false;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/playlists/pl-1/tracks"))
        posted = true;
    });
    const ordered = page.waitForRequest((r) =>
      r.url().endsWith("/api/rekordbox/playlists/pl-1/order"),
    );

    await dragTo(
      page,
      page.locator('[data-track-id="pl-match"]'),
      await rowPoint(page, "Playlist Clash", "lower"),
    );
    await page.mouse.up();

    expect((await ordered).postDataJSON()).toEqual({
      entry_ids: ["e-src", "e-pl-clash", "e-pl-match"],
    });
    expect(posted).toBe(false);
  });

  test("drags a match onto another playlist in the tree", async ({ page }) => {
    await openForSource(page);
    const added = page.waitForRequest(
      (r) =>
        r.method() === "POST" &&
        r.url().endsWith("/api/rekordbox/playlists/pl-2/tracks"),
    );
    const warmup = page.getByTestId("playlist-drop-target").filter({
      hasText: "Warmup",
    });
    const box = (await warmup.boundingBox())!;
    await dragTo(page, page.locator('[data-track-id="same"]'), {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    await page.mouse.up();

    expect((await added).postDataJSON()).toEqual({ track_ids: ["same"] });
  });

  test("dropping on the panel itself does nothing", async ({ page }) => {
    await openForSource(page);
    let edited = false;
    page.on("request", (r) => {
      if (
        r.url().includes("/api/rekordbox/playlists/pl-1/") &&
        r.method() !== "GET"
      )
        edited = true;
    });
    const target = (await page
      .locator('[data-track-id="detuned"]')
      .boundingBox())!;
    await dragTo(page, page.locator('[data-track-id="same"]'), {
      x: target.x + 20,
      y: target.y + target.height / 2,
    });
    await expect(page.getByTestId("playlist-insert-line")).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(edited).toBe(false);
  });
});
