/**
 * Playwright globalSetup for screenshots.
 *
 * Fetches real track metadata from the iTunes Search API (no auth required)
 * and writes the results to .cache/screenshot-tracks.json.  The screenshots
 * spec picks that file up automatically and uses real artwork/titles.
 *
 * Falls back to built-in placeholder data if the fetch fails or returns too
 * few results.
 *
 * Cache TTL: 24 hours — re-fetched only when stale.
 */

import path from 'path';
import fs from 'fs';

const CACHE_FILE = path.join(__dirname, '../../.cache/screenshot-tracks.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ARTIST_QUERIES = [
  'pegassi',
  'mischluft',
  'mika heggemann',
  'marlon hoffstadt',
  'funk tribu',
  'dj sonnenbrand',
  'butschi',
  'cleopard2000',
  'linds',
  'trancemaster krause',
];

export interface RealTrack {
  id: number;
  urn: string;
  title: string;
  artist: string;
  artwork_url: string | null;
  genre: string | null;
  duration: number;
  playback_count: number;
  likes_count: number;
  permalink_url: string;
}

interface CacheFile {
  fetchedAt: number;
  tracks: RealTrack[];
  feedTracks: RealTrack[];
}

function isCacheValid(): boolean {
  if (!fs.existsSync(CACHE_FILE)) return false;
  try {
    const data: CacheFile = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    return Date.now() - data.fetchedAt < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

interface ItunesTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  artworkUrl100: string;
  primaryGenreName: string;
  trackTimeMillis: number;
  trackViewUrl: string;
}

async function fetchTracksForArtist(query: string, limit = 3): Promise<RealTrack[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&media=music&limit=${limit}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json() as { results: ItunesTrack[] };
    return (data.results ?? []).map((t) => ({
      id: t.trackId,
      urn: `itunes:tracks:${t.trackId}`,
      title: t.trackName,
      artist: t.artistName,
      artwork_url: t.artworkUrl100?.replace('100x100bb', '500x500bb') ?? null,
      genre: t.primaryGenreName ?? null,
      duration: t.trackTimeMillis ?? 300000,
      playback_count: 10000 + (t.trackId % 90000),
      likes_count: 500 + (t.trackId % 5000),
      permalink_url: t.trackViewUrl,
    }));
  } catch {
    return [];
  }
}

export default async function globalSetup() {
  if (isCacheValid()) {
    console.log('[screenshots] Using cached track data (< 24h old)');
    return;
  }

  console.log('[screenshots] Fetching track data from iTunes…');

  const seen = new Set<number>();
  const tracks: RealTrack[] = [];
  const feedTracks: RealTrack[] = [];

  for (const query of ARTIST_QUERIES) {
    const results = await fetchTracksForArtist(query, 3);
    for (const t of results) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (tracks.length < 16) tracks.push(t);
      else if (feedTracks.length < 16) feedTracks.push(t);
    }
    if (tracks.length >= 16 && feedTracks.length >= 16) break;
  }

  if (tracks.length < 4) {
    console.log('[screenshots] Too few results from iTunes — using placeholder data');
    return;
  }

  // If not enough distinct feed tracks, reuse some liked tracks
  if (feedTracks.length < 4) {
    feedTracks.push(...tracks.slice(0, 8));
  }

  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const cache: CacheFile = { fetchedAt: Date.now(), tracks, feedTracks };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`[screenshots] Cached ${tracks.length} tracks + ${feedTracks.length} feed tracks`);
}
