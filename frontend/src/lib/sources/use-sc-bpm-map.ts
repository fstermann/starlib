"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

/** Numeric SoundCloud track id parsed from a `soundcloud:tracks:<id>` urn. */
export function scTrackId(track: SCTrack): number | null {
  if (!track.urn) return null;
  const id = parseInt(track.urn.split(":").pop() ?? "", 10);
  return id > 0 ? id : null;
}

/**
 * Bulk-fetch cached SoundCloud BPMs (analysed or manually-set, from the
 * backend `soundcloud_track_bpm` table) for `tracks`, keyed by numeric track
 * id. This is the same one-request-per-list prefill the likes table does for
 * its BPM column, lifted so the filter layer can see real BPM values too —
 * `track.bpm` (SoundCloud metadata) is null for most user uploads.
 *
 * Best-effort: a failed request leaves the previous map in place; consumers
 * fall back to metadata BPM.
 */
export function useScBpmMap(tracks: SCTrack[]): Map<number, number> {
  const [map, setMap] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    const ids: number[] = [];
    for (const t of tracks) {
      const id = scTrackId(t);
      if (id != null) ids.push(id);
    }
    if (ids.length === 0) return;
    let cancelled = false;
    api
      .getSoundcloudBpmsBulk(ids)
      .then((resp) => {
        if (cancelled) return;
        const next = new Map<number, number>();
        for (const [k, v] of Object.entries(resp.bpms)) next.set(Number(k), v);
        setMap(next);
      })
      .catch(() => {
        /* Prefill is best-effort; predicate falls back to metadata BPM. */
      });
    return () => {
      cancelled = true;
    };
  }, [tracks]);
  return map;
}
