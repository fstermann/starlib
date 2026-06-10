import { parseSCTimestamp, type SCTrack } from "@/lib/soundcloud";

/** Parse the backend's semicolon-delimited comment string into structured fields. */
export function parseComment(raw: string | null | undefined): {
  soundcloud_id: string;
  soundcloud_permalink: string;
} {
  const result: Record<string, string> = {};
  if (raw) {
    for (const pair of raw.split(/;\s*\n?/)) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = pair
          .slice(idx + 1)
          .trim()
          .replace(/\\;/g, ";")
          .replace(/\\=/g, "=")
          .replace(/\\\\/g, "\\");
        result[k] = v;
      }
    }
  }
  return {
    soundcloud_id: result["soundcloud_id"] ?? "",
    soundcloud_permalink: result["soundcloud_permalink"] ?? "",
  };
}

/** Serialize structured comment fields back to the backend's format. */
export function serializeComment(scId: string, scPermalink: string): string {
  const escape = (v: string) =>
    v.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/;/g, "\\;");
  const parts = ["version=1.0"];
  if (scId) parts.push(`soundcloud_id=${escape(scId)}`);
  if (scPermalink) parts.push(`soundcloud_permalink=${escape(scPermalink)}`);
  return parts.join("; \n");
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
    const m =
      track.release_month && track.release_month > 0 ? track.release_month : 1;
    const d =
      track.release_day && track.release_day > 0 ? track.release_day : 1;
    return `${track.release_year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const ts = parseSCTimestamp(track.created_at);
  if (ts != null) return new Date(ts).toISOString().slice(0, 10);
  return undefined;
}

/** Format bytes as human-readable size. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a duration in seconds as M:SS or H:MM:SS. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
