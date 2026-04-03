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
import { test, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import type { RealTrack } from './screenshots-setup';

const SCREENSHOT_DIR = path.join(__dirname, '../../docs/assets/images/screenshots');
const CACHE_FILE = path.join(__dirname, '../../.cache/screenshot-tracks.json');

const MOCK_USER = {
  id: 123456,
  username: 'dj-starlib',
  permalink: 'dj-starlib',
  avatar_url: 'https://placehold.co/200x200/1a1a2e/e94560?text=DJ',
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
    genre: ['Melodic House', 'Melodic Techno', 'Progressive House', 'Deep House'][i % 4],
    duration: 300000 + i * 30000,
    bpm: 120 + (i % 8),
    key_signature: ['Cm', 'Am', 'Dm', 'Fm', 'Gm', 'Bbm'][i % 6],
    created_at: new Date(2026, 2, 25 - i).toISOString(),
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
    artwork_url: t.artwork_url ?? `https://placehold.co/500x500/1a1a2e/e94560?text=${index + 1}`,
    genre: t.genre ?? ['Melodic House', 'Melodic Techno', 'Progressive House', 'Deep House'][index % 4],
    duration: t.duration,
    bpm: 122 + (index % 8),
    key_signature: ['Cm', 'Am', 'Dm', 'Fm', 'Gm', 'Bbm'][index % 6],
    created_at: createdAt.toISOString(),
    playback_count: t.playback_count,
    likes_count: t.likes_count,
    permalink_url: t.permalink_url,
  };
}

const PLACEHOLDER_TITLES = [
  'Superstition', 'Memory', 'Sable Beach', 'Beyond Beliefs',
  'Radiate', 'Because You Move Me', 'No Captain', 'You Make Me',
  'Push It', 'Eternity', 'Turja', 'Strand',
];
const PLACEHOLDER_ARTISTS = [
  'Pegassi', 'Mischluft', 'Mika Heggemann', 'Ben Böhmer',
  'Yotto', 'Tinlicker', 'Lane 8', 'Nils Hoffmann',
  'CamelPhat', 'Anyma', 'Monolink', 'Stephan Bodzin',
];
const PLACEHOLDER_FEED_TITLES = [
  'Retrograde', 'Parallels', 'Waterfalls', 'Slow Motion',
  'Edge of Seventeen', 'In Another Life', 'Diamonds', 'Panta Rhei',
  'Blockchain', 'Shadowbox', 'Low', 'Body Language',
];

let MOCK_TRACKS: ReturnType<typeof buildSCTrack>[];
let MOCK_FEED_TRACKS: ReturnType<typeof buildSCTrack>[];

if (fs.existsSync(CACHE_FILE)) {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  const realTracks: RealTrack[] = cache.tracks ?? [];
  const realFeed: RealTrack[] = cache.feedTracks ?? [];
  console.log(`[screenshots] Using ${realTracks.length} real tracks + ${realFeed.length} feed tracks from cache`);
  MOCK_TRACKS = realTracks
    .slice(0, 12)
    .map((t, i) => buildSCTrack(t, i, new Date(2026, 2, 25 - i)));
  MOCK_FEED_TRACKS = realFeed
    .slice(0, 12)
    .map((t, i) => buildSCTrack(t, i, new Date(2026, 2, 26 - i)));
} else {
  MOCK_TRACKS = makePlaceholderTracks(12, 1000, PLACEHOLDER_TITLES, PLACEHOLDER_ARTISTS, 'Track');
  MOCK_FEED_TRACKS = makePlaceholderTracks(12, 3000, PLACEHOLDER_FEED_TITLES, PLACEHOLDER_ARTISTS, 'Feed');
}

async function mockScreenshotApi(page: Page) {
  // Setup status — configured
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true }),
    }),
  );

  // Health check
  await page.route('**/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    }),
  );

  // Folder initialization
  await page.route('**/api/metadata/folders/initialize', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, message: 'Folders initialized' }),
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
      file_format: 'mp3',
      has_artwork: !!t.artwork_url,
    };
  });
  await page.route('**/api/metadata/folders/*/files*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: fileItems, total: fileItems.length, page: 1, size: 50, pages: 1 }),
    }),
  );

  // Artwork — look up the SoundCloud CDN URL from the map and proxy it
  await page.route(/\/api\/metadata\/files\/.+\/artwork/, async (route) => {
    const rawPath = new URL(route.request().url()).pathname
      .replace(/^\/api\/metadata\/files\//, '')
      .replace(/\/artwork$/, '');
    const filePath = decodeURIComponent(rawPath);
    const artworkUrl = fileArtworkMap.get(filePath) ?? MOCK_TRACKS[0].artwork_url;
    if (!artworkUrl) { await route.fulfill({ status: 404 }); return; }
    try {
      const resp = await fetch(artworkUrl);
      const buffer = Buffer.from(await resp.arrayBuffer());
      await route.fulfill({
        status: 200,
        contentType: resp.headers.get('content-type') ?? 'image/jpeg',
        body: buffer,
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });

  // Image proxy (SoundCloud CDN images used in like-explorer / weekly)
  await page.route('**/api/metadata/proxy-image*', async (route) => {
    const imageUrl = new URL(route.request().url()).searchParams.get('url') ?? '';
    try {
      const resp = await fetch(imageUrl);
      const buffer = Buffer.from(await resp.arrayBuffer());
      await route.fulfill({
        status: 200,
        contentType: resp.headers.get('content-type') ?? 'image/png',
        body: buffer,
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });

  // Browse endpoint
  await page.route('**/api/metadata/folders/*/browse*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, size: 50, pages: 0 }),
    }),
  );

  // Filter values
  await page.route('**/api/metadata/folders/*/filters*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ genres: ['House', 'Melodic Techno', 'Progressive House', 'Deep House'], keys: ['Cm', 'Am', 'Dm'], bpm_min: 118, bpm_max: 132 }),
    }),
  );

  // SoundCloud likes (direct API call)
  await page.route('https://api.soundcloud.com/me/likes/tracks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        collection: MOCK_TRACKS,
        next_href: null,
      }),
    }),
  );

  // SoundCloud user search (direct API call)
  await page.route('https://api.soundcloud.com/users*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        collection: MOCK_TRACKS.slice(0, 5).map((t) => t.user),
        next_href: null,
      }),
    }),
  );

  // SoundCloud track search (used by meta editor SC panel — return empty to avoid errors)
  await page.route('https://api.soundcloud.com/tracks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );

  // Weekly feed (direct API call) — uses different IDs from liked tracks so filters don't hide everything
  await page.route('https://api.soundcloud.com/me/feed/tracks*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        collection: MOCK_FEED_TRACKS.map((t) => ({
          type: 'track',
          origin: t,
          created_at: t.created_at,
        })),
        next_href: null,
      }),
    }),
  );

  // Collection status
  await page.route('**/api/metadata/collection/status*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    }),
  );

  // Collection SoundCloud IDs
  await page.route('**/api/metadata/collection/soundcloud-ids*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ids: [] }),
    }),
  );

  // Track info — used when a file is clicked in edit mode
  await page.route(/\/api\/metadata\/files\/.+\/info/, (route) => {
    const t = MOCK_TRACKS[0];
    const filePath = `/music/${t.user.username} - ${t.title}.mp3`;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file_path: filePath,
        file_name: `${t.user.username} - ${t.title}.mp3`,
        title: t.title,
        artist: t.user.username,
        bpm: t.bpm ?? null,
        key: t.key_signature ?? null,
        genre: t.genre ?? null,
        comment: null,
        release_date: t.created_at ? t.created_at.split('T')[0] : null,
        remixers: null,
        has_artwork: !!t.artwork_url,
        is_ready: true,
        missing_fields: [],
        issues: [],
      }),
    });
  });

  // Playlists (direct API call)
  await page.route('https://api.soundcloud.com/me/playlists*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ collection: [], next_href: null }),
    }),
  );
}

function hideDevToolbar(page: Page) {
  return page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = 'nextjs-portal { display: none !important; }';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
    // Also inject immediately in case DOMContentLoaded already fired
    if (document.head) document.head.appendChild(style);
  });
}

function injectAuthTokens(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem('access_token', 'mock-token-for-screenshots');
    localStorage.setItem('refresh_token', 'mock-refresh-token');
    localStorage.setItem(
      'token_expires_at',
      String(Date.now() + 3600 * 1000),
    );
    localStorage.setItem('sc_user', JSON.stringify({
      id: 123456,
      username: 'dj-starlib',
      permalink: 'dj-starlib',
      avatar_url: 'https://placehold.co/200x200/1a1a2e/e94560?text=DJ',
    }));
  });
}

test.describe('Documentation screenshots', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });

  test.beforeEach(async ({ page }) => {
    await mockScreenshotApi(page);
    await injectAuthTokens(page);
    await hideDevToolbar(page);
  });

  test('home page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'home.png'),
      fullPage: false,
    });
  });

  test('meta editor', async ({ page }) => {
    await page.goto('/meta-editor?view=edit');
    await page.waitForLoadState('networkidle');
    // Click the first file to open the edit panel
    const firstFile = page.locator('[data-file-path]').first();
    await firstFile.waitFor({ state: 'visible' });
    await firstFile.click();
    // Wait for the editor fields and artwork to settle
    await page.locator('input[placeholder="Title"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'meta-editor.png'),
      fullPage: false,
    });
  });

  test('like explorer', async ({ page }) => {
    await page.goto('/like-explorer');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'like-explorer.png'),
      fullPage: false,
    });
  });

  test('weekly favorites', async ({ page }) => {
    await page.goto('/weekly');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'weekly.png'),
      fullPage: false,
    });
  });

  test('setup page', async ({ page }) => {
    // Clear auth to show setup flow
    await page.addInitScript(() => {
      localStorage.clear();
    });
    // Override setup status to show unconfigured
    await page.route('**/api/setup/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: false }),
      }),
    );
    await page.goto('/setup');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'setup.png'),
      fullPage: false,
    });
  });

  test('login page', async ({ page }) => {
    // Clear auth tokens to show login page
    await page.addInitScript(() => {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('token_expires_at');
      localStorage.removeItem('sc_user');
    });
    await page.goto('/auth/login');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'login.png'),
      fullPage: false,
    });
  });
});
