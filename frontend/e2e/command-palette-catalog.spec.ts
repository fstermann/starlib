import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Enforces that every command rendered in the palette is documented in
 * `docs/guide/command-palette.md`. Drift is the failure mode — adding a
 * command without updating the docs should fail CI.
 *
 * Dynamic ids (e.g. `local:/path`, `sc-track:urn`) are covered by the prefix
 * list; fixed ids (nav, actions) must appear in the explicit set.
 *
 * When you add a new command, update BOTH:
 *   1. `docs/guide/command-palette.md` (the authoritative table)
 *   2. `KNOWN_COMMAND_IDS` / `KNOWN_COMMAND_PREFIXES` below
 */

/** Fixed command ids that should appear in the palette at least once across
 * the contexts this test exercises. */
const KNOWN_COMMAND_IDS = new Set<string>([
  // Actions
  "settings:open",
  "theme:toggle",
  "auth:connect",
  "auth:disconnect",
  "sc:create-playlist-from-selection",
  "sc:reload",
  // Nav / Go to
  "nav:/library",
  "nav:/weekly",
  "nav:/library?source=filesystem",
  "nav:/library?source=soundcloud&tab=me",
  "nav:/library?source=soundcloud&tab=discover",
  "nav:/library?source=soundcloud&tab=search",
]);

/** Allowed ID prefixes for dynamic providers (folder shortcuts, search hits). */
const KNOWN_COMMAND_PREFIXES = [
  "folder:",
  "local:",
  "sc-track:",
  "sc-user:",
];

async function setupMocks(page: Page) {
  // Seed token so the SC client runs.
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
        username: "tester",
        permalink: "tester",
        avatar_url: null,
      }),
    );
  });

  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          urn: "soundcloud:tracks:999",
          title: "CatalogTrack",
          permalink_url: "https://soundcloud.com/u/catalog",
          user: { username: "catalog-user" },
        },
      ]),
    }),
  );
  await page.route(/api\.soundcloud\.com\/users\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          urn: "soundcloud:users:42",
          username: "catalog-user",
          permalink: "catalog-user",
          avatar_url: null,
          followers_count: 0,
        },
      ]),
    }),
  );
  await page.route(
    /\/api\/metadata\/folders\/collection\/browse\?.*search=/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              title: "CatalogLocal",
              artist: "CatalogArtist",
              file_path: "/music/collection/catalog.aif",
              file_name: "catalog.aif",
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
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "/music" }),
    }),
  );
  await page.route("**/api/metadata/collection/soundcloud-ids", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );
}

async function collectCommandIds(page: Page): Promise<Set<string>> {
  const ids = new Set<string>();
  // Empty palette (captures always-on nav + actions).
  await page
    .getByRole("button", { name: /open command palette/i })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const empty = await dialog.locator("[data-command-id]").all();
  for (const el of empty) {
    const id = await el.getAttribute("data-command-id");
    if (id) ids.add(id);
  }
  // Typed query (captures async-provider groups).
  await dialog.getByPlaceholder(/search or type a command/i).fill("catalog");
  await expect(dialog.getByText("CatalogTrack")).toBeVisible();
  await expect(dialog.getByText("CatalogLocal")).toBeVisible();
  const typed = await dialog.locator("[data-command-id]").all();
  for (const el of typed) {
    const id = await el.getAttribute("data-command-id");
    if (id) ids.add(id);
  }
  await page.keyboard.press("Escape");
  return ids;
}

function isKnown(id: string): boolean {
  if (KNOWN_COMMAND_IDS.has(id)) return true;
  return KNOWN_COMMAND_PREFIXES.some((p) => id.startsWith(p));
}

test.describe("Command palette catalog", () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page);
  });

  test("every rendered command is documented", async ({ page }) => {
    // Hit several contexts so gated commands show up. The auth user is
    // pre-seeded in setupMocks, so "Disconnect" appears; we visit the
    // library page with selection-dependent commands un-activated (the
    // create-playlist command won't render here — that's fine: this test
    // only catches UNKNOWN rendered ids, not missing ones).
    const seen = new Set<string>();

    await page.goto("/library?source=soundcloud&tab=search");
    const a = await collectCommandIds(page);
    a.forEach((id) => seen.add(id));

    // Clear auth and revisit to capture the `auth:connect` gate path.
    await page.evaluate(() => {
      window.localStorage.removeItem("sc_user");
      window.dispatchEvent(new Event("auth-changed"));
    });
    await page.goto("/library");
    const b = await collectCommandIds(page);
    b.forEach((id) => seen.add(id));

    const unknown: string[] = [];
    for (const id of seen) {
      if (!isKnown(id)) unknown.push(id);
    }
    expect(
      unknown,
      `Undocumented commands rendered in the palette. Add them to docs/guide/command-palette.md and to KNOWN_COMMAND_IDS/PREFIXES in this spec: ${unknown.join(", ")}`,
    ).toEqual([]);
  });
});
