import { useEffect, useState } from "react";

import { api, fetchApi } from "@/lib/api";
import type { PlayerTrack } from "@/lib/player-context";

export interface RekordboxPlaylist {
  id: string;
  name: string;
  parent_id: string | null;
  is_folder: boolean;
  is_smart: boolean;
  track_count: number;
}

export interface RekordboxTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  bpm: number | null;
  key: string | null;
  duration_seconds: number | null;
  file_path: string | null;
  comment: string | null;
  soundcloud_id: number | null;
  date_added: string | null;
  release_date: string | null;
  has_artwork: boolean;
  has_waveform: boolean;
  /** This row's playlist slot; set only for editable (regular, local) playlists. */
  entry_id: string | null;
}

type TracksResult = { tracks: RekordboxTrack[] };

/** Player entry for a Rekordbox track; null when it has no local file. */
export function rekordboxPlayerTrack(
  t: RekordboxTrack,
  device: string,
): PlayerTrack | null {
  if (!t.file_path) return null;
  const usb = !!device;
  return {
    filePath: t.file_path,
    fileName: t.file_path.split("/").pop() ?? t.title,
    title: t.title,
    artist: t.artist ?? undefined,
    bpm: t.bpm ?? null,
    // Use the Rekordbox artwork endpoint (same source as the table row), not the
    // metadata file endpoint — the USB path is off-root there, and this keeps the
    // player cover consistent with the row. Full variant for the expanded view.
    artworkUrl: t.has_artwork
      ? api.getRekordboxArtworkUrl(t.id, false, device || undefined)
      : undefined,
    rekordboxId: t.has_waveform ? t.id : undefined,
    rekordboxDevice: usb ? device : undefined,
    musicalKey: t.key ?? undefined,
    durationSec: t.duration_seconds ?? undefined,
    // Stream by id: the file may sit outside the music root (or on a USB
    // device), where the local file-path endpoint refuses it.
    streamUrl: api.getRekordboxAudioUrl(t.id, device || undefined),
  };
}

/** Sentinel `?playlist=` value for the whole collection. Rekordbox playlist
 *  ids are numeric, so it can't collide. */
export const COLLECTION_ID = "collection";

export interface RekordboxStatus {
  available: boolean;
  reason: string | null;
}

export interface RekordboxUsbDevice {
  id: string;
  label: string;
  mount_path: string;
}

/** Append `?device=` when a USB export is selected; omit for the local install. */
function withDevice(path: string, device: string | null): string {
  if (!device) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}device=${encodeURIComponent(device)}`;
}

interface AsyncState<T> {
  data: T;
  loading: boolean;
  /** True once the first fetch has resolved (success or error). */
  loaded: boolean;
  error: string | null;
  refetch: () => void;
  /** Replace the data in place, e.g. with the result of an edit. */
  setData: (data: T) => void;
}

function useRekordboxFetch<T>(
  path: string | null,
  initial: T,
  pollMs?: number,
): AsyncState<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const fetchKey = `${path}|${tick}`;
  const [startedKey, setStartedKey] = useState<string | null>(null);
  if (fetchKey !== startedKey) {
    setStartedKey(fetchKey);
    if (path === null) setData(initial);
    setLoading(path !== null);
    setError(null);
  }

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    fetchApi<T>(path)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  // Optional background polling — used to keep the USB device list live so a
  // disconnect is noticed without a manual reload.
  useEffect(() => {
    if (path === null || !pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [path, pollMs]);

  const refetch = () => setTick((t) => t + 1);
  return { data, loading, loaded, error, refetch, setData };
}

export function useRekordboxDevices(pollMs?: number): AsyncState<{
  devices: RekordboxUsbDevice[];
}> {
  return useRekordboxFetch<{ devices: RekordboxUsbDevice[] }>(
    "/api/rekordbox/usb/devices",
    { devices: [] },
    pollMs,
  );
}

export function useRekordboxStatus(
  device: string | null = null,
): AsyncState<RekordboxStatus> {
  return useRekordboxFetch<RekordboxStatus>(
    withDevice("/api/rekordbox/status", device),
    { available: false, reason: null },
  );
}

export function useRekordboxPlaylists(
  enabled: boolean,
  device: string | null = null,
): AsyncState<{
  playlists: RekordboxPlaylist[];
}> {
  return useRekordboxFetch<{ playlists: RekordboxPlaylist[] }>(
    enabled ? withDevice("/api/rekordbox/playlists", device) : null,
    { playlists: [] },
  );
}

export function useRekordboxPlaylistTracks(
  playlistId: string | null,
  device: string | null = null,
): AsyncState<TracksResult> {
  return useRekordboxFetch<TracksResult>(
    playlistId
      ? withDevice(`/api/rekordbox/playlists/${playlistId}/tracks`, device)
      : null,
    { tracks: [] },
  );
}

/** Every track in the selected source's collection. */
export function useRekordboxCollection(
  enabled: boolean,
  device: string | null = null,
): AsyncState<TracksResult> {
  return useRekordboxFetch<TracksResult>(
    enabled ? withDevice("/api/rekordbox/tracks", device) : null,
    { tracks: [] },
  );
}

/** Whether the Rekordbox app is running (which blocks local edits), polled so
 *  closing Rekordbox clears the notice. */
export function useRekordboxRunning(
  enabled: boolean,
  pollMs: number,
): AsyncState<{ running: boolean }> {
  return useRekordboxFetch<{ running: boolean }>(
    enabled ? "/api/rekordbox/running" : null,
    { running: false },
    pollMs,
  );
}

export function createRekordboxPlaylist(
  name: string,
  parentId: string | null,
  isFolder: boolean,
): Promise<RekordboxPlaylist> {
  return fetchApi("/api/rekordbox/playlists", {
    method: "POST",
    body: JSON.stringify({ name, parent_id: parentId, is_folder: isFolder }),
  });
}

export function renameRekordboxPlaylist(
  playlistId: string,
  name: string,
): Promise<RekordboxPlaylist> {
  return fetchApi(`/api/rekordbox/playlists/${playlistId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

/** Deletes a playlist, or a folder with everything inside it. */
export function deleteRekordboxPlaylist(playlistId: string): Promise<void> {
  return fetchApi(`/api/rekordbox/playlists/${playlistId}`, {
    method: "DELETE",
  });
}

/** Playlist edits apply to the local install only. Each returns the playlist's
 *  tracks after the edit. A 409 means Rekordbox is running. */
export function addRekordboxPlaylistTracks(
  playlistId: string,
  trackIds: string[],
): Promise<TracksResult> {
  return fetchApi(`/api/rekordbox/playlists/${playlistId}/tracks`, {
    method: "POST",
    body: JSON.stringify({ track_ids: trackIds }),
  });
}

export function removeRekordboxPlaylistEntries(
  playlistId: string,
  entryIds: string[],
): Promise<TracksResult> {
  return fetchApi(`/api/rekordbox/playlists/${playlistId}/tracks/remove`, {
    method: "POST",
    body: JSON.stringify({ entry_ids: entryIds }),
  });
}

export function reorderRekordboxPlaylist(
  playlistId: string,
  entryIds: string[],
): Promise<TracksResult> {
  return fetchApi(`/api/rekordbox/playlists/${playlistId}/order`, {
    method: "PUT",
    body: JSON.stringify({ entry_ids: entryIds }),
  });
}
