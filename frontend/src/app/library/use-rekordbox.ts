import { useEffect, useState } from "react";

import { fetchApi } from "@/lib/api";

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
}

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
  error: string | null;
  refetch: () => void;
}

function useRekordboxFetch<T>(path: string | null, initial: T): AsyncState<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(initial);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApi<T>(path)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // initial is intentionally stable per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick]);

  const refetch = () => setTick((t) => t + 1);
  return { data, loading, error, refetch };
}

export function useRekordboxDevices(): AsyncState<{
  devices: RekordboxUsbDevice[];
}> {
  return useRekordboxFetch("/api/rekordbox/usb/devices", { devices: [] });
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
  return useRekordboxFetch(
    enabled ? withDevice("/api/rekordbox/playlists", device) : null,
    { playlists: [] },
  );
}

export function useRekordboxPlaylistTracks(
  playlistId: string | null,
  device: string | null = null,
): AsyncState<{ tracks: RekordboxTrack[] }> {
  return useRekordboxFetch(
    playlistId
      ? withDevice(`/api/rekordbox/playlists/${playlistId}/tracks`, device)
      : null,
    { tracks: [] },
  );
}
