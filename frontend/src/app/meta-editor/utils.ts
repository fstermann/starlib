import type { SCTrack } from '@/lib/soundcloud';

/** Parse the backend's semicolon-delimited comment string into structured fields. */
export function parseComment(raw: string | null | undefined): { soundcloud_id: string; soundcloud_permalink: string } {
  const result: Record<string, string> = {};
  if (raw) {
    for (const pair of raw.split(/;\s*\n?/)) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim()
          .replace(/\\;/g, ';')
          .replace(/\\=/g, '=')
          .replace(/\\\\/g, '\\');
        result[k] = v;
      }
    }
  }
  return {
    soundcloud_id: result['soundcloud_id'] ?? '',
    soundcloud_permalink: result['soundcloud_permalink'] ?? '',
  };
}

/** Serialize structured comment fields back to the backend's format. */
export function serializeComment(scId: string, scPermalink: string): string {
  const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/;/g, '\\;');
  const parts = ['version=1.0'];
  if (scId) parts.push(`soundcloud_id=${escape(scId)}`);
  if (scPermalink) parts.push(`soundcloud_permalink=${escape(scPermalink)}`);
  return parts.join('; \n');
}

/** Strip query string and fragment from a URL. */
export function stripQueryParams(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Extract a YYYY-MM-DD date string from a SoundCloud track.
 * Tries release_year/month/day first, then falls back to created_at.
 */
export function scReleaseDate(track: SCTrack): string | undefined {
  if (track.release_year && track.release_year > 0) {
    const m = track.release_month && track.release_month > 0 ? track.release_month : 1;
    const d = track.release_day && track.release_day > 0 ? track.release_day : 1;
    return `${track.release_year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (track.created_at) {
    const normalized = track.created_at.replace(/\//g, '-').replace(' ', 'T').replace(' +0000', 'Z');
    const date = new Date(normalized);
    if (!isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

/** Format bytes as human-readable size. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
