/**
 * Automated screenshot capture for documentation.
 *
 * Captures screenshots of each page with mock data and saves them to
 * docs/assets/images/screenshots/ for use in the user guide.
 *
 * Usage:
 *   cd frontend
 *   npx playwright test e2e/screenshots.spec.ts
 *
 * Real track data (artwork, titles) is fetched automatically from the iTunes
 * Search API on first run and cached in .cache/screenshot-tracks.json for 24h.
 */
import fs from "fs";
import path from "path";
import { test, type Page } from "@playwright/test";

import type { RealTrack } from "./screenshots-setup";

const SCREENSHOT_DIR = path.join(
  __dirname,
  "../../docs/assets/images/screenshots",
);
const CACHE_FILE = path.join(__dirname, "../../.cache/screenshot-tracks.json");

const MOCK_USER = {
  id: 123456,
  username: "dj-starlib",
  permalink: "dj-starlib",
  avatar_url: "https://placehold.co/200x200/1a1a2e/e94560?text=DJ",
};

// ---------------------------------------------------------------------------
// Track data: real SoundCloud data when available, otherwise placeholders
// ---------------------------------------------------------------------------

function makePlaceholderTracks(
  count: number,
  idOffset: number,
  titles: string[],
  artists: string[],
  artworkPrefix: string,
): ReturnType<typeof buildSCTrack>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: idOffset + i,
    urn: `soundcloud:tracks:${idOffset + i}`,
    title: titles[i % titles.length],
    user: {
      id: 200 + i,
      username: artists[i % artists.length],
      avatar_url: `https://placehold.co/100x100/16213e/e94560?text=${i + 1}`,
    },
    artwork_url: `https://placehold.co/500x500/1a1a2e/e94560?text=${artworkPrefix}+${i + 1}`,
    genre: [
      "Melodic House",
      "Melodic Techno",
      "Progressive House",
      "Deep House",
    ][i % 4],
    duration: 300000 + i * 30000,
    bpm: 120 + (i % 8),
    key_signature: ["Cm", "Am", "Dm", "Fm", "Gm", "Bbm"][i % 6],
    created_at: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
    playback_count: 10000 + i * 5000,
    likes_count: 500 + i * 200,
    permalink_url: `https://soundcloud.com/artist/track-${idOffset + i}`,
  }));
}

function buildSCTrack(t: RealTrack, index: number, createdAt: Date) {
  return {
    id: t.id,
    urn: t.urn,
    title: t.title,
    user: {
      id: 200 + index,
      username: t.artist,
      avatar_url: `https://placehold.co/100x100/16213e/e94560?text=${index + 1}`,
    },
    artwork_url:
      t.artwork_url ??
      `https://placehold.co/500x500/1a1a2e/e94560?text=${index + 1}`,
    genre:
      t.genre ??
      ["Melodic House", "Melodic Techno", "Progressive House", "Deep House"][
        index % 4
      ],
    duration: t.duration,
    bpm: 122 + (index % 8),
    key_signature: ["Cm", "Am", "Dm", "Fm", "Gm", "Bbm"][index % 6],
    created_at: createdAt.toISOString(),
    playback_count: t.playback_count,
    likes_count: t.likes_count,
    permalink_url: t.permalink_url,
  };
}

const PLACEHOLDER_TITLES = [
  "Superstition",
  "Memory",
  "Sable Beach",
  "Beyond Beliefs",
  "Radiate",
  "Because You Move Me",
  "No Captain",
  "You Make Me",
  "Push It",
  "Eternity",
  "Turja",
  "Strand",
];
const PLACEHOLDER_ARTISTS = [
  "Pegassi",
  "Mischluft",
  "Mika Heggemann",
  "Ben Böhmer",
  "Yotto",
  "Tinlicker",
  "Lane 8",
  "Nils Hoffmann",
  "CamelPhat",
  "Anyma",
  "Monolink",
  "Stephan Bodzin",
];
const PLACEHOLDER_FEED_TITLES = [
  "Retrograde",
  "Parallels",
  "Waterfalls",
  "Slow Motion",
  "Edge of Seventeen",
  "In Another Life",
  "Diamonds",
  "Panta Rhei",
  "Blockchain",
  "Shadowbox",
  "Low",
  "Body Language",
];

let MOCK_TRACKS: ReturnType<typeof buildSCTrack>[];
let MOCK_FEED_TRACKS: ReturnType<typeof buildSCTrack>[];

if (fs.existsSync(CACHE_FILE)) {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  const realTracks: RealTrack[] = cache.tracks ?? [];
  const realFeed: RealTrack[] = cache.feedTracks ?? [];
  console.log(
    `[screenshots] Using ${realTracks.length} real tracks + ${realFeed.length} feed tracks from cache`,
  );
  MOCK_TRACKS = realTracks
    .slice(0, 12)
    .map((t, i) =>
      buildSCTrack(t, i, new Date(Date.now() - i * 24 * 60 * 60 * 1000)),
    );
  MOCK_FEED_TRACKS = realFeed
    .slice(0, 12)
    .map((t, i) =>
      buildSCTrack(t, i, new Date(Date.now() - i * 24 * 60 * 60 * 1000)),
    );
} else {
  MOCK_TRACKS = makePlaceholderTracks(
    12,
    1000,
    PLACEHOLDER_TITLES,
    PLACEHOLDER_ARTISTS,
    "Track",
  );
  MOCK_FEED_TRACKS = makePlaceholderTracks(
    12,
    3000,
    PLACEHOLDER_FEED_TITLES,
    PLACEHOLDER_ARTISTS,
    "Feed",
  );
}

async function mockScreenshotApi(page: Page) {
  // Setup status — configured
  await page.route("**/api/setup/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true }),
    }),
  );

  // Health check
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );

  // Folder initialization
  await page.route("**/api/metadata/folders/initialize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, message: "Folders initialized" }),
    }),
  );

  // File listing — clean file_paths, no ?artwork= encoding tricks
  const fileArtworkMap = new Map<string, string>();
  const fileItems = MOCK_TRACKS.slice(0, 8).map((t) => {
    const filePath = `/music/${t.user.username} - ${t.title}.mp3`;
    if (t.artwork_url) fileArtworkMap.set(filePath, t.artwork_url);
    return {
      file_path: filePath,
      file_name: `${t.user.username} - ${t.title}.mp3`,
      file_size: 8_000_000 + t.id * 1000,
      file_format: "mp3",
      has_artwork: !!t.artwork_url,
    };
  });
  await page.route("**/api/metadata/folders/*/files*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: fileItems,
        total: fileItems.length,
        page: 1,
        size: 50,
        pages: 1,
      }),
    }),
  );

  // Artwork — look up the SoundCloud CDN URL from the map and proxy it
  await page.route(/\/api\/metadata\/files\/.+\/artwork/, async (route) => {
    const rawPath = new URL(route.request().url()).pathname
      .replace(/^\/api\/metadata\/files\//, "")
      .replace(/\/artwork$/, "");
    const filePath = decodeURIComponent(rawPath);
    const artworkUrl =
      fileArtworkMap.get(filePath) ?? MOCK_TRACKS[0].artwork_url;
    if (!artworkUrl) {
      await route.fulfill({ status: 404 });
      return;
    }
    try {
      const resp = await fetch(artworkUrl);
      const buffer = Buffer.from(await resp.arrayBuffer());
      await route.fulfill({
        status: 200,
        contentType: resp.headers.get("content-type") ?? "image/jpeg",
        body: buffer,
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });

  // Image proxy (SoundCloud CDN images used in like-explorer / weekly)
  await page.route("**/api/metadata/proxy-image*", async (route) => {
    const imageUrl =
      new URL(route.request().url()).searchParams.get("url") ?? "";
    try {
      const resp = await fetch(imageUrl);
      const buffer = Buffer.from(await resp.arrayBuffer());
      await route.fulfill({
        status: 200,
        contentType: resp.headers.get("content-type") ?? "image/png",
        body: buffer,
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });

  // Browse endpoint — return the same tracks as the file listing with full TrackBrowse fields
  const browseItems = MOCK_TRACKS.slice(0, 8).map((t, i) => {
    const filePath = `/music/${t.user.username} - ${t.title}.mp3`;
    return {
      file_path: filePath,
      file_name: `${t.user.username} - ${t.title}.mp3`,
      file_size: 8_000_000 + t.id * 1000,
      file_format: "mp3",
      has_artwork: !!t.artwork_url,
      title: t.title,
      artist: t.user.username,
      bpm: t.bpm ?? null,
      key: t.key_signature ?? null,
      genre: t.genre ?? null,
      comment: null,
      release_date: t.created_at ? t.created_at.split("T")[0] : null,
      remixers: null,
      soundcloud_id: i < 4 ? t.id : null,
      duration: t.duration ? t.duration / 1000 : null,
      mtime: Date.now() / 1000 - i * 86400,
    };
  });
  await page.route("**/api/metadata/folders/*/browse*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: browseItems,
        total: browseItems.length,
        page: 1,
        size: 50,
        pages: 1,
      }),
    }),
  );

  // Filter values
  await page.route("**/api/metadata/folders/*/filter-values*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        genres: ["House", "Melodic Techno", "Progressive House", "Deep House"],
        genre_counts: {},
        artists: [],
        keys: ["Cm", "Am", "Dm"],
        key_counts: {},
        bpm_min: 118,
        bpm_max: 132,
      }),
    }),
  );

  // SoundCloud likes (direct API call)
  await page.route("https://api.soundcloud.com/me/likes/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: MOCK_TRACKS,
        next_href: null,
      }),
    }),
  );

  // SoundCloud user search (direct API call)
  await page.route("https://api.soundcloud.com/users*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: MOCK_TRACKS.slice(0, 5).map((t) => t.user),
        next_href: null,
      }),
    }),
  );

  // SoundCloud track search (used by meta editor SC panel — return empty to avoid errors)
  await page.route("https://api.soundcloud.com/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );

  // Weekly feed (direct API call) — uses different IDs from liked tracks so filters don't hide everything
  await page.route("https://api.soundcloud.com/me/feed/tracks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        collection: MOCK_FEED_TRACKS.map((t) => ({
          type: "track",
          origin: t,
          created_at: t.created_at,
        })),
        next_href: null,
      }),
    }),
  );

  // Collection status
  await page.route("**/api/metadata/collection/status*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );

  // Collection SoundCloud IDs
  await page.route("**/api/metadata/collection/soundcloud-ids*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ids: [] }),
    }),
  );

  // App settings
  await page.route("**/api/settings", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          preferred_output_format: "aiff",
          root_music_folder: "~/Music/tracks",
        }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: route.request().postData() ?? "{}",
      });
    }
  });

  // Root music folder
  await page.route("**/api/settings/root-folder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root_music_folder: "~/Music/tracks" }),
    }),
  );

  // Rulesets
  await page.route("**/api/rulesets", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rulesets: [
            {
              id: "classic",
              name: "Classic",
              is_builtin: true,
              rules: [
                {
                  id: "convert",
                  type: "convert",
                  input: "source",
                  requires: [],
                  params: { format: "preferred", quality: 320 },
                },
                {
                  id: "archive",
                  type: "move",
                  input: "convert.original",
                  requires: ["convert.converted"],
                  params: { folder: "archive" },
                },
                {
                  id: "move",
                  type: "move",
                  input: "convert.result",
                  requires: [],
                  params: { folder: "cleaned" },
                },
              ],
            },
          ],
          active_ruleset_id: "classic",
        }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    }
  });

  // Active ruleset
  await page.route("**/api/rulesets/active", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "classic",
        name: "Classic",
        is_builtin: true,
        rules: [
          {
            id: "convert",
            type: "convert",
            input: "source",
            requires: [],
            params: { format: "preferred", quality: 320 },
          },
          {
            id: "archive",
            type: "move",
            input: "convert.original",
            requires: ["convert.converted"],
            params: { folder: "archive" },
          },
          {
            id: "move",
            type: "move",
            input: "convert.result",
            requires: [],
            params: { folder: "cleaned" },
          },
        ],
      }),
    }),
  );

  // Folders config
  await page.route("**/api/folders/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        folders: [
          { name: "prepare", label: "Prepare", visible: true, order: 0 },
          { name: "cleaned", label: "Cleaned", visible: true, order: 1 },
          { name: "collection", label: "Collection", visible: true, order: 2 },
        ],
      }),
    }),
  );

  // Folder tree
  await page.route("**/api/metadata/folders/tree", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "/music",
        name: "music",
        children: [
          {
            id: "/music/prepare",
            name: "prepare",
            children: [
              {
                id: "/music/prepare/new-arrivals",
                name: "new-arrivals",
                children: [],
              },
              {
                id: "/music/prepare/to-review",
                name: "to-review",
                children: [],
              },
            ],
          },
          {
            id: "/music/cleaned",
            name: "cleaned",
            children: [
              { id: "/music/cleaned/2024", name: "2024", children: [] },
              { id: "/music/cleaned/2025", name: "2025", children: [] },
            ],
          },
          {
            id: "/music/collection",
            name: "collection",
            children: [
              {
                id: "/music/collection/house",
                name: "house",
                children: [
                  {
                    id: "/music/collection/house/deep-house",
                    name: "deep-house",
                    children: [],
                  },
                  {
                    id: "/music/collection/house/melodic-house",
                    name: "melodic-house",
                    children: [],
                  },
                  {
                    id: "/music/collection/house/progressive-house",
                    name: "progressive-house",
                    children: [],
                  },
                ],
              },
              {
                id: "/music/collection/techno",
                name: "techno",
                children: [
                  {
                    id: "/music/collection/techno/melodic-techno",
                    name: "melodic-techno",
                    children: [],
                  },
                  {
                    id: "/music/collection/techno/peak-time",
                    name: "peak-time",
                    children: [],
                  },
                ],
              },
              {
                id: "/music/collection/ambient",
                name: "ambient",
                children: [],
              },
            ],
          },
          { id: "/music/archive", name: "archive", children: [] },
        ],
      }),
    }),
  );

  // Single folder ruleset
  await page.route("**/api/folders/ruleset?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: "", ruleset_id: null }),
    }),
  );

  // All folder rulesets (registered after single so it takes priority)
  await page.route("**/api/folders/rulesets-by-path", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ folder_rulesets: {} }),
    }),
  );

  // Browse by path (match query string start to avoid matching filter-values)
  await page.route(/\/api\/metadata\/folders\/browse-path\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: browseItems,
        total: browseItems.length,
        page: 1,
        size: 50,
        pages: 1,
      }),
    }),
  );

  // Browse path filter values
  await page.route(
    "**/api/metadata/folders/browse-path/filter-values*",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          genres: [
            "House",
            "Melodic Techno",
            "Progressive House",
            "Deep House",
          ],
          genre_counts: {},
          artists: [],
          keys: ["Cm", "Am", "Dm"],
          key_counts: {},
          bpm_min: 118,
          bpm_max: 132,
        }),
      }),
  );

  // Waveform peaks
  await page.route(/\/api\/metadata\/files\/.+\/peaks/, (route) => {
    const peaks = Array.from({ length: 60 }, () => 0.2 + Math.random() * 0.6);
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ peaks }),
    });
  });

  // Track info — used when a file is clicked in edit mode
  await page.route(/\/api\/metadata\/files\/.+\/info/, (route) => {
    const t = MOCK_TRACKS[0];
    const filePath = `/music/${t.user.username} - ${t.title}.mp3`;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        file_path: filePath,
        file_name: `${t.user.username} - ${t.title}.mp3`,
        title: t.title,
        artist: t.user.username,
        bpm: t.bpm ?? null,
        key: t.key_signature ?? null,
        genre: t.genre ?? null,
        comment: null,
        release_date: t.created_at ? t.created_at.split("T")[0] : null,
        remixers: null,
        has_artwork: !!t.artwork_url,
        is_ready: true,
        missing_fields: [],
        issues: [],
      }),
    });
  });

  // Playlists (direct API call)
  await page.route("https://api.soundcloud.com/me/playlists*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
}

function hideDevToolbar(page: Page) {
  return page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () =>
      document.head.appendChild(style),
    );
    // Also inject immediately in case DOMContentLoaded already fired
    if (document.head) document.head.appendChild(style);
  });
}

function injectAuthTokens(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem("access_token", "mock-token-for-screenshots");
    localStorage.setItem("refresh_token", "mock-refresh-token");
    localStorage.setItem("token_expires_at", String(Date.now() + 3600 * 1000));
    localStorage.setItem(
      "sc_user",
      JSON.stringify({
        id: 123456,
        username: "dj-starlib",
        permalink: "dj-starlib",
        avatar_url: "https://placehold.co/200x200/1a1a2e/e94560?text=DJ",
      }),
    );
    // Pre-expand tree panel nodes to showcase the folder hierarchy
    localStorage.setItem(
      "tree-panel-expanded:filesystem",
      JSON.stringify([
        "/music",
        "/music/prepare",
        "/music/cleaned",
        "/music/collection",
        "/music/collection/house",
        "/music/collection/techno",
      ]),
    );
  });
}

test.describe("Documentation screenshots", () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });

  test.beforeEach(async ({ page }) => {
    await mockScreenshotApi(page);
    await injectAuthTokens(page);
    await hideDevToolbar(page);
  });

  test("home page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "home.png"),
      fullPage: false,
    });
  });

  test("meta editor — table view", async ({ page }) => {
    await page.goto("/meta-editor");
    await page.waitForLoadState("networkidle");
    // Wait for table rows to render
    const firstRow = page.locator('[role="row"][class*="border-b"]').first();
    await firstRow.waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "meta-editor.png"),
      fullPage: false,
    });
  });

  test("meta editor — single file editor", async ({ page }) => {
    await page.goto("/meta-editor");
    await page.waitForLoadState("networkidle");
    // Wait for editable rows (skip the header row)
    const dataRow = page.locator('[data-index="0"]');
    await dataRow.waitFor({ state: "visible" });
    // Click the filename span (has cursor-pointer + hover:text-foreground classes)
    const fileName = dataRow.locator("span.cursor-pointer").first();
    await fileName.click();
    // Wait for the single-file editor panel to settle (uses data-slot="input" from shadcn Input component)
    await page
      .locator('input[data-slot="input"][placeholder="Title"]')
      .waitFor({ state: "visible" });
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "meta-editor-single.png"),
      fullPage: false,
    });
  });

  test("like explorer", async ({ page }) => {
    await page.goto("/like-explorer");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "like-explorer.png"),
      fullPage: false,
    });
  });

  test("weekly favorites", async ({ page }) => {
    await page.goto("/weekly");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "weekly.png"),
      fullPage: false,
    });
  });

  test("setup page", async ({ page }) => {
    // Clear auth to show setup flow
    await page.addInitScript(() => {
      localStorage.clear();
    });
    // Override setup status to show unconfigured
    await page.route("**/api/setup/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: false }),
      }),
    );
    await page.goto("/setup");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "setup.png"),
      fullPage: false,
    });
  });

  test("settings — folders", async ({ page }) => {
    await page.goto("/meta-editor");
    await page.waitForLoadState("networkidle");
    // Open settings dialog via sidebar button
    await page.locator('button[aria-label="Settings"]').click();
    await page
      .locator('[data-slot="dialog-content"]')
      .waitFor({ state: "visible" });
    // Navigate to Folders section
    await page.getByText("Folders", { exact: true }).click();
    await page.waitForTimeout(300);
    // Screenshot just the dialog content
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-folders.png"),
    });
  });

  test("settings — rulesets (classic)", async ({ page }) => {
    await page.goto("/meta-editor");
    await page.waitForLoadState("networkidle");
    // Open settings dialog
    await page.locator('button[aria-label="Settings"]').click();
    await page
      .locator('[data-slot="dialog-content"]')
      .waitFor({ state: "visible" });
    // Navigate to Rulesets section
    await page.getByText("Rulesets", { exact: true }).click();
    await page.waitForTimeout(300);
    // Screenshot just the dialog content
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-rulesets.png"),
    });
  });

  test("login page", async ({ page }) => {
    // Clear auth tokens to show login page
    await page.addInitScript(() => {
      localStorage.removeItem("access_token");
      localStorage.removeItem("refresh_token");
      localStorage.removeItem("token_expires_at");
      localStorage.removeItem("sc_user");
    });
    await page.goto("/auth/login");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "login.png"),
      fullPage: false,
    });
  });
});
