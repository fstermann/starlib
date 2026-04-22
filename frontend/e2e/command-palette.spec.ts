import { expect, test } from "./fixtures";

/**
 * Command palette end-to-end tests.
 *
 * These cover the extensibility architecture end-to-end:
 * - Global ⌘P hotkey + the top-bar search trigger both open the palette
 * - Nav provider (static sync) contributes "Go to" commands
 * - Dynamic `useCommand` registrations show up (theme toggle, etc.)
 * - Pinned-folder sync provider resolves shortcut names to absolute paths
 * - Local + SoundCloud async providers fire SIMULTANEOUSLY on the same query
 * - Selecting a SoundCloud track navigates to ?tab=search&q=<palette-query>&play=<urn>
 * - Selecting a local track navigates to ?source=filesystem&search=<query>&play=<path>
 *
 * Each behavior deserves its own test — if a provider regresses silently, the
 * palette looks the same but stops contributing commands. Surface those fast.
 */

async function mockSoundCloud(page: import("@playwright/test").Page) {
  // Seed a fake auth token so the SC client doesn't try to refresh.
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "fake-token");
    window.localStorage.setItem(
      "token_expires_at",
      String(Date.now() + 60 * 60 * 1000),
    );
  });

  // Global SoundCloud track search.
  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          urn: "soundcloud:tracks:111",
          title: "Remote Track A",
          permalink_url: "https://soundcloud.com/u/a",
          user: { username: "user-a" },
        },
        {
          urn: "soundcloud:tracks:222",
          title: "Remote Track B",
          permalink_url: "https://soundcloud.com/u/b",
          user: { username: "user-b" },
        },
      ]),
    }),
  );

  // SoundCloud user search (fetch-based, not openapi client).
  await page.route(/api\.soundcloud\.com\/users\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );

  // Stream URL fetch (for autoplay).
  await page.route("**/api/soundcloud/tracks/*/stream*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://example.com/fake.m3u8",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }),
  );
}

async function mockLocalLibrary(page: import("@playwright/test").Page) {
  // Collection browse returns matching local tracks when ?search= is set.
  await page.route(
    /\/api\/metadata\/folders\/collection\/browse\?.*search=/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              title: "Local Track X",
              artist: "Local Artist",
              file_path: "/music/collection/x.aif",
              file_name: "x.aif",
              folder: "/music/collection",
              file_format: "aif",
              has_artwork: false,
            },
          ],
          total: 1,
          page: 1,
          size: 8,
          pages: 1,
        }),
      }),
  );

  // Root music folder — used by the pinned-folders provider to resolve
  // legacy `{name}` shortcuts to absolute paths.
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );

  // SoundCloud-ids (called by soundcloud-view on mount).
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );
}

test.describe("Command palette", () => {
  test.beforeEach(async ({ page }) => {
    await mockSoundCloud(page);
    await mockLocalLibrary(page);
  });

  test("opens with the top-bar trigger and with ⌘P", async ({ page }) => {
    await page.goto("/library");
    const trigger = page.getByRole("button", { name: /open command palette/i });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Hotkey path — press on the body to ensure window receives the event.
    await page.locator("body").press("Meta+p");
    await expect(dialog).toBeVisible();
  });

  test("shows nav + theme commands by default", async ({ page }) => {
    await page.goto("/library");
    await page.getByRole("button", { name: /open command palette/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/go to library/i).first()).toBeVisible();
    await expect(dialog.getByText(/soundcloud.*search/i).first()).toBeVisible();
    await expect(dialog.getByText(/switch to .* theme/i)).toBeVisible();
  });

  test("pinned folders resolve to absolute paths", async ({ page }) => {
    await page.goto("/library?source=filesystem");
    await page.getByRole("button", { name: /open command palette/i }).click();
    const dialog = page.getByRole("dialog");
    const item = dialog.getByRole("option", {
      name: /open folder: collection/i,
    });
    await expect(item).toBeVisible();
    await item.click();
    await expect(page).toHaveURL(/nodeId=%2Fmusic%2Fcollection/);
  });

  test("local + SoundCloud search fire in parallel on the same query", async ({
    page,
  }) => {
    await page.goto("/library");
    await page.getByRole("button", { name: /open command palette/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/search or type a command/i).fill("track");
    // Both async providers populate results.
    await expect(dialog.getByText("Local Track X")).toBeVisible();
    await expect(dialog.getByText("Remote Track A")).toBeVisible();
    await expect(dialog.getByText("Remote Track B")).toBeVisible();
  });

  test("selecting a SoundCloud track jumps to search tab with query + play", async ({
    page,
  }) => {
    await page.goto("/library");
    await page.getByRole("button", { name: /open command palette/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/search or type a command/i).fill("track");
    await dialog.getByText("Remote Track B").click();
    await expect(page).toHaveURL(/tab=search/);
    await expect(page).toHaveURL(/q=track/);
    await expect(page).toHaveURL(/play=soundcloud%3Atracks%3A222/);
  });

  test("selecting a local track jumps to filesystem with search + play", async ({
    page,
  }) => {
    await page.goto("/library");
    await page.getByRole("button", { name: /open command palette/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/search or type a command/i).fill("track");
    await dialog.getByText("Local Track X").click();
    await expect(page).toHaveURL(/source=filesystem/);
    await expect(page).toHaveURL(/search=track/);
    await expect(page).toHaveURL(/play=%2Fmusic%2Fcollection%2Fx\.aif/);
  });

  test("nav command navigates to the destination", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /open command palette/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/search or type a command/i).fill("weekly");
    await dialog
      .getByRole("option", { name: /go to weekly/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/weekly/);
  });
});
