import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Dragging SoundCloud track rows onto one of the user's playlist nodes in the
 * sidebar appends them (the checkbox selection when the dragged row is part of
 * it). SoundCloud's playlist PUT replaces the track set, so the write carries
 * the existing tracks plus the dropped ones.
 */

const LIKED = [
  {
    id: 42,
    urn: "soundcloud:tracks:42",
    title: "Track Alpha",
    user: { id: 1, username: "me" },
    duration: 200_000,
  },
  {
    id: 99,
    urn: "soundcloud:tracks:99",
    title: "Track Bravo",
    user: { id: 1, username: "me" },
    duration: 200_000,
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function setup(page: Page) {
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
      "tree-panel-expanded:library:soundcloud:me",
      JSON.stringify(["playlists"]),
    );
  });
  await page.route("https://api.soundcloud.com/tracks*", (r) =>
    r.fulfill(json([])),
  );
  await page.route("https://api.soundcloud.com/me/feed/tracks*", (r) =>
    r.fulfill(json({ collection: [], next_href: null })),
  );
  await page.route("**/api/metadata/collection/soundcloud-ids", (r) =>
    r.fulfill(json([])),
  );
  await page.route("**/api/bpm/soundcloud/bulk", (r) =>
    r.fulfill(json({ bpms: {} })),
  );
  await page.route("**/api/settings/root-folder", (r) =>
    r.fulfill(json({ root_music_folder: "/music" })),
  );
  await page.route("https://api.soundcloud.com/me/likes/tracks*", (r) =>
    r.fulfill(json({ collection: LIKED, next_href: null })),
  );
  await page.route("https://api.soundcloud.com/me/playlists*", (r) =>
    r.fulfill(
      json({
        collection: [
          { urn: "soundcloud:playlists:100", title: "My Set", track_count: 1 },
        ],
        next_href: null,
      }),
    ),
  );
  await page.route("https://api.soundcloud.com/playlists/**", (route) => {
    const req = route.request();
    if (req.method() === "GET" && req.url().includes("/tracks")) {
      return route.fulfill(
        json({
          collection: [{ id: 1001, urn: "soundcloud:tracks:1001" }],
          next_href: null,
        }),
      );
    }
    return route.fulfill(
      json({ urn: "soundcloud:playlists:100", title: "My Set" }),
    );
  });
}

async function dragRowOntoPlaylist(page: Page, rowIndex: number) {
  const row = page.locator(`[data-index="${rowIndex}"] [role="row"]`);
  const target = page
    .getByTestId("playlist-drop-target")
    .filter({ hasText: "My Set" });
  const from = (await row.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 10, {
    steps: 5,
  });
  await expect(page.getByTestId("track-drag-overlay")).toBeVisible();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10,
  });
  await expect(target).toHaveAttribute("data-drop-over", "true");
  await page.mouse.up();
}

function waitForPlaylistPut(page: Page) {
  return page.waitForRequest(
    (req) =>
      req.method() === "PUT" &&
      req.url().includes("/playlists/") &&
      !req.url().includes("/tracks"),
  );
}

function putUrns(req: import("@playwright/test").Request) {
  return (
    req.postDataJSON() as { playlist: { tracks: { urn: string }[] } }
  ).playlist.tracks.map((t) => t.urn);
}

test.describe("soundcloud drag tracks to playlist", () => {
  test("dropping a row on a playlist node appends the track", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });

    const put = waitForPlaylistPut(page);
    await dragRowOntoPlaylist(page, 1);
    expect(putUrns(await put)).toEqual([
      "soundcloud:tracks:1001",
      "soundcloud:tracks:99",
    ]);
    await expect(page.getByText('Added to "My Set"')).toBeVisible();
  });

  test("dragging a selected row drops the whole selection", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/library?source=soundcloud");
    await expect(page.locator("[data-index]")).toHaveCount(2, {
      timeout: 5000,
    });
    await page.getByRole("checkbox", { name: /select all/i }).click();

    const put = waitForPlaylistPut(page);
    await dragRowOntoPlaylist(page, 0);
    await expect(page.getByTestId("track-drag-overlay")).toHaveCount(0);
    expect(putUrns(await put)).toEqual([
      "soundcloud:tracks:1001",
      "soundcloud:tracks:42",
      "soundcloud:tracks:99",
    ]);
    await expect(page.getByText('Added 2 tracks to "My Set"')).toBeVisible();
  });
});
