import type { Page, Request, Route } from "@playwright/test";

import { expect, test } from "./fixtures";

const PLAYLISTS = [
  {
    id: "f-1",
    name: "Crates",
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
    id: "pl-2",
    name: "Warmup",
    parent_id: null,
    is_folder: false,
    is_smart: false,
    track_count: 0,
  },
  {
    id: "smart-1",
    name: "Recent 148+",
    parent_id: null,
    is_folder: false,
    is_smart: true,
    track_count: 2,
  },
];

function track(id: string, title: string, entryId: string | null) {
  return {
    id,
    title,
    artist: null,
    album: null,
    genre: null,
    bpm: null,
    key: null,
    duration_seconds: 300,
    file_path: `/music/${title}.flac`,
    comment: null,
    soundcloud_id: null,
    date_added: null,
    release_date: null,
    has_artwork: false,
    has_waveform: false,
    entry_id: entryId,
  };
}

const FOO = track("t-1", "Foo", "e-1");
const BAZ = track("t-2", "Baz", "e-2");

function json(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}

async function openSundayMix(page: Page) {
  await page.route(
    "**/api/rekordbox/status",
    json({ available: true, reason: null }),
  );
  await page.route(
    "**/api/rekordbox/playlists",
    json({ playlists: PLAYLISTS }),
  );
  await page.route(
    "**/api/rekordbox/playlists/pl-1/tracks",
    json({ tracks: [FOO, BAZ] }),
  );
  await page.route(
    "**/api/rekordbox/playlists/smart-1/tracks",
    json({ tracks: [track("t-1", "Foo", null), track("t-2", "Baz", null)] }),
  );
  await page.goto("/library?source=rekordbox&playlist=pl-1");
  await expect(rowTitle(page, "Baz")).toBeVisible();
}

function rowTitle(page: Page, title: string) {
  return page.getByTestId("rekordbox-tracks").getByText(title, { exact: true });
}

function titles(page: Page) {
  return page
    .getByTestId("rekordbox-tracks")
    .locator("[data-index] span.font-medium")
    .allTextContents();
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 5 });
  await expect(page.getByTestId("track-drag-overlay")).toBeVisible();
  await page.mouse.move(to.x, to.y, { steps: 10 });
}

async function center(locator: ReturnType<Page["getByText"]>) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const isEdit = (path: string, method: string) => (req: Request) =>
  req.method() === method && req.url().endsWith(path);

test.describe("Library: Rekordbox playlist editing", () => {
  test("removes a track via the context menu", async ({ page }) => {
    await openSundayMix(page);
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks/remove",
      json({ tracks: [BAZ] }),
    );

    await rowTitle(page, "Foo").click({ button: "right" });
    const request = page.waitForRequest(
      isEdit("/playlists/pl-1/tracks/remove", "POST"),
    );
    await page.getByTestId("rekordbox-remove-from-playlist").click();

    expect((await request).postDataJSON()).toEqual({ entry_ids: ["e-1"] });
    await expect(rowTitle(page, "Foo")).toHaveCount(0);
    await expect(rowTitle(page, "Baz")).toBeVisible();
  });

  test("adds the selection to another playlist via the context menu", async ({
    page,
  }) => {
    await openSundayMix(page);
    await page.route(
      "**/api/rekordbox/playlists/pl-2/tracks",
      json({ tracks: [FOO, BAZ] }),
    );

    await page
      .getByTestId("rekordbox-tracks")
      .getByRole("checkbox", { name: "Select all" })
      .click();
    await rowTitle(page, "Foo").click({ button: "right" });
    await page.getByTestId("rekordbox-add-to-playlist").click();
    const request = page.waitForRequest(
      isEdit("/playlists/pl-2/tracks", "POST"),
    );
    await page.getByRole("menuitem", { name: "Warmup" }).click();

    expect((await request).postDataJSON()).toEqual({
      track_ids: ["t-1", "t-2"],
    });
    await expect(page.getByText("Added 2 tracks to Warmup")).toBeVisible();
  });

  test("adds a track by dragging it onto a sidebar playlist", async ({
    page,
  }) => {
    await openSundayMix(page);
    await page.route(
      "**/api/rekordbox/playlists/pl-2/tracks",
      json({ tracks: [BAZ] }),
    );
    const target = page
      .getByTestId("playlist-drop-target")
      .filter({ hasText: "Warmup" });
    // The open playlist is not a drop target for itself.
    await expect(
      page
        .getByTestId("playlist-drop-target")
        .filter({ hasText: "Sunday Mix" }),
    ).toHaveCount(0);

    const request = page.waitForRequest(
      isEdit("/playlists/pl-2/tracks", "POST"),
    );
    await drag(page, await center(rowTitle(page, "Baz")), await center(target));
    await expect(target).toHaveAttribute("data-drop-over", "true");
    await page.mouse.up();

    expect((await request).postDataJSON()).toEqual({ track_ids: ["t-2"] });
    await expect(page.getByText("Added 1 track to Warmup")).toBeVisible();
  });

  test("reorders tracks by dragging a row", async ({ page }) => {
    await openSundayMix(page);
    await page.route(
      "**/api/rekordbox/playlists/pl-1/order",
      json({ tracks: [BAZ, FOO] }),
    );

    const request = page.waitForRequest(isEdit("/playlists/pl-1/order", "PUT"));
    const foo = await center(rowTitle(page, "Foo"));
    await drag(page, await center(rowTitle(page, "Baz")), {
      x: foo.x,
      y: foo.y - 10,
    });
    await page.mouse.up();

    expect((await request).postDataJSON()).toEqual({
      entry_ids: ["e-2", "e-1"],
    });
    await expect.poll(() => titles(page)).toEqual(["Baz", "Foo"]);
  });

  test("keeps the order and explains when Rekordbox is running", async ({
    page,
  }) => {
    await openSundayMix(page);
    await page.route(
      "**/api/rekordbox/playlists/pl-1/order",
      json({ detail: "Close Rekordbox to save playlist changes." }, 409),
    );

    const foo = await center(rowTitle(page, "Foo"));
    await drag(page, await center(rowTitle(page, "Baz")), {
      x: foo.x,
      y: foo.y - 10,
    });
    await page.mouse.up();

    await expect(page.getByText("Couldn't save playlist")).toBeVisible();
    await expect(
      page.getByText("Close Rekordbox to save playlist changes."),
    ).toBeVisible();
    await expect.poll(() => titles(page)).toEqual(["Foo", "Baz"]);
  });

  test("smart playlists offer add but not remove", async ({ page }) => {
    await openSundayMix(page);
    await page.getByText("Recent 148+").click();

    await rowTitle(page, "Foo").click({ button: "right" });
    await expect(page.getByTestId("rekordbox-add-to-playlist")).toBeVisible();
    await expect(
      page.getByTestId("rekordbox-remove-from-playlist"),
    ).toHaveCount(0);
  });

  test("shows a notice while Rekordbox is running", async ({ page }) => {
    await page.route("**/api/rekordbox/running", json({ running: true }));
    await openSundayMix(page);

    await expect(page.getByTestId("rekordbox-running-notice")).toHaveText(
      "Rekordbox is open. Close it to save playlist changes.",
    );
  });

  test("undoes a removal from the toast", async ({ page }) => {
    await openSundayMix(page);
    const readded = { ...FOO, entry_id: "e-9" };
    await page.route(
      "**/api/rekordbox/playlists/pl-1/tracks/remove",
      json({ tracks: [BAZ] }),
    );
    await page.route("**/api/rekordbox/playlists/pl-1/tracks", (route) =>
      route.request().method() === "POST"
        ? json({ tracks: [BAZ, readded] })(route)
        : route.fallback(),
    );
    await page.route(
      "**/api/rekordbox/playlists/pl-1/order",
      json({ tracks: [readded, BAZ] }),
    );

    await rowTitle(page, "Foo").click({ button: "right" });
    await page.getByTestId("rekordbox-remove-from-playlist").click();
    await expect(rowTitle(page, "Foo")).toHaveCount(0);

    const add = page.waitForRequest(isEdit("/playlists/pl-1/tracks", "POST"));
    const order = page.waitForRequest(isEdit("/playlists/pl-1/order", "PUT"));
    await page.getByRole("button", { name: "Undo" }).click();

    expect((await add).postDataJSON()).toEqual({ track_ids: ["t-1"] });
    expect((await order).postDataJSON()).toEqual({
      entry_ids: ["e-9", "e-2"],
    });
  });

  test("browses the collection and adds tracks from it", async ({ page }) => {
    await page.route(
      "**/api/rekordbox/tracks",
      json({ tracks: [track("t-1", "Foo", null), track("t-3", "Qux", null)] }),
    );
    await page.route(
      "**/api/rekordbox/playlists/pl-2/tracks",
      json({ tracks: [] }),
    );
    await openSundayMix(page);

    await page.getByText("Collection", { exact: true }).click();
    await expect(page).toHaveURL(/playlist=collection/);
    await expect(rowTitle(page, "Qux")).toBeVisible();

    await rowTitle(page, "Qux").click({ button: "right" });
    await expect(
      page.getByTestId("rekordbox-remove-from-playlist"),
    ).toHaveCount(0);
    await page.getByTestId("rekordbox-add-to-playlist").click();
    const request = page.waitForRequest(
      isEdit("/playlists/pl-2/tracks", "POST"),
    );
    await page.getByRole("menuitem", { name: "Warmup" }).click();

    expect((await request).postDataJSON()).toEqual({ track_ids: ["t-3"] });
  });

  test("creates a playlist inside a folder from the sidebar", async ({
    page,
  }) => {
    await openSundayMix(page);
    await page.route("**/api/rekordbox/playlists", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              id: "pl-9",
              name: "Peak time",
              parent_id: "f-1",
              is_folder: false,
              is_smart: false,
              track_count: 0,
            }),
          })
        : route.fallback(),
    );

    await page.getByText("Crates", { exact: true }).click({ button: "right" });
    await page.getByTestId("rekordbox-new-playlist").click();
    await page.getByLabel("Name").fill("Peak time");
    const request = page.waitForRequest(isEdit("/rekordbox/playlists", "POST"));
    await page.getByLabel("Name").press("Enter");

    expect((await request).postDataJSON()).toEqual({
      name: "Peak time",
      parent_id: "f-1",
      is_folder: false,
    });
    await expect(page.getByText('Created "Peak time"')).toBeVisible();
    await expect(page).toHaveURL(/playlist=pl-9/);
  });

  test("deletes the open playlist from the sidebar", async ({ page }) => {
    await openSundayMix(page);
    await page.route("**/api/rekordbox/playlists/pl-1", (route) =>
      route.fulfill({ status: 204 }),
    );

    await page
      .getByText("Sunday Mix", { exact: true })
      .click({ button: "right" });
    await page.getByTestId("rekordbox-delete-playlist").click();
    const request = page.waitForRequest(
      isEdit("/rekordbox/playlists/pl-1", "DELETE"),
    );
    await page.getByTestId("rekordbox-delete-playlist-confirm").click();

    await request;
    await expect(page.getByText('Deleted "Sunday Mix"')).toBeVisible();
    await expect(page).not.toHaveURL(/playlist=pl-1/);
  });

  test("renames a folder from the sidebar", async ({ page }) => {
    await openSundayMix(page);
    await page.route("**/api/rekordbox/playlists/f-1", (route) =>
      json({ ...PLAYLISTS[0], name: "Vinyl" })(route),
    );

    await page.getByText("Crates", { exact: true }).click({ button: "right" });
    await page.getByTestId("rekordbox-rename-playlist").click();
    await expect(
      page.getByRole("dialog", { name: "Rename folder" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Crates",
    );
    await page.getByRole("textbox", { name: "Name" }).fill("Vinyl");
    const request = page.waitForRequest(
      isEdit("/rekordbox/playlists/f-1", "PATCH"),
    );
    await page.getByRole("button", { name: "Save" }).click();

    expect((await request).postDataJSON()).toEqual({ name: "Vinyl" });
    await expect(page.getByText('Renamed to "Vinyl"')).toBeVisible();
  });
});
