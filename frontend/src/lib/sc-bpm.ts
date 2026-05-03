/** Shared SoundCloud BPM analysis helper.
 *
 * Calls the Rust analyser against SoundCloud's public API. SoundCloud
 * refuses streaming for some tracks (label uploads, geo-restricted,
 * monetisation-only), and that propagates here as a 403/404 from
 * ``api.soundcloud.com``. The frontend treats those as "not analysable"
 * — a calmer UI signal than a generic "BPM detection failed" toast —
 * by raising :class:`TrackUnanalysableError`.
 */

import { api } from "@/lib/api";
import { analyzeScBpm, type BpmResult } from "@/lib/tauri";

/** Raised when SoundCloud refuses the stream URL (403 / 404). The track
 * exists but isn't available for analysis or playback through any API
 * path we have access to. */
export class TrackUnanalysableError extends Error {
  constructor(
    message = "This track can't be analysed (SoundCloud restricted)",
  ) {
    super(message);
    this.name = "TrackUnanalysableError";
  }
}

function isUnanalysable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bhttp\s+(403|404)\b/i.test(msg);
}

/**
 * Run BPM detection for a SoundCloud track. Throws
 * :class:`TrackUnanalysableError` on 403/404; rethrows other errors as-is.
 */
export async function analyzeSc(
  trackId: number,
  consensus = false,
): Promise<BpmResult> {
  try {
    const { token } = await api.getSoundcloudClientToken();
    return await analyzeScBpm(trackId, token, consensus);
  } catch (err) {
    if (isUnanalysable(err)) {
      throw new TrackUnanalysableError();
    }
    throw err;
  }
}
