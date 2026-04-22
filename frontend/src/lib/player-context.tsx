"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export interface PlayerTrack {
  filePath: string;
  fileName: string;
  title?: string;
  artist?: string;
  /** When set, WaveformPlayer loads this URL directly (local file path is
   * ignored for audio). `.m3u8` URLs are played via hls.js. Used for
   * SoundCloud HLS playback where there is no local file. */
  streamUrl?: string;
  /** Pre-rendered waveform image URL (SoundCloud `waveform_url`). When set,
   * WaveformPlayer skips backend peak decoding and uses a placeholder. */
  waveformUrl?: string;
  /** Opaque handle callers can use to refresh the stream URL (e.g. on 403).
   * Typically the SoundCloud track id. */
  streamRefreshKey?: string | number;
  /** External URL the track originates from (e.g. SoundCloud permalink).
   * Rendered as a link next to the title in the mini player. */
  permalinkUrl?: string;
  /** Artwork URL. For local files, the backend's `/artwork` endpoint; for
   * SoundCloud tracks, the CDN `artwork_url`. Surfaced to the OS media
   * widget via the Media Session API. */
  artworkUrl?: string;
}

interface PlayerContextValue {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  /** Load a single track without playing. Replaces the queue with [track]. */
  load: (track: PlayerTrack) => void;
  /** Play a single track. Replaces the queue with [track]. */
  play: (track: PlayerTrack) => void;
  /** Replace the queue with `tracks` and start playback at `index`. */
  playQueue: (tracks: PlayerTrack[], index: number) => void;
  pause: () => void;
  toggle: (track?: PlayerTrack) => void;
  stop: () => void;
  /** Seek to a position (0–1) in the current track. */
  seek: (ratio: number) => void;
  /** Advance to the next track in the queue. No-op at end. */
  next: () => void;
  /** Go to previous track, or restart current if playback is past 3s. */
  previous: () => void;
  /** Peek at the next queued track without advancing. Used by the player
   * to prefetch stream URL + peaks so skip-to-next is near-instant. */
  peekNext: () => PlayerTrack | null;
  hasNext: boolean;
  hasPrevious: boolean;
  /** Subscribe to playback progress updates (0–1). Immediately called with current value. Returns unsubscribe fn. */
  subscribeProgress: (fn: (p: number) => void) => () => void;
  /** Called by WaveformPlayer to push real-time progress. */
  reportProgress: (p: number) => void;
  /** Called by WaveformPlayer to expose its WaveSurfer seek function. */
  registerSeek: (fn: ((ratio: number) => void) | null) => void;
  /** Duration in seconds of the currently loaded track (0 when unknown). */
  duration: number;
  /** Called by WaveformPlayer once the track is decoded. */
  reportDuration: (d: number) => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

function sameTrack(a: PlayerTrack | null, b: PlayerTrack | null) {
  if (!a || !b) return a === b;
  return a.filePath === b.filePath;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  const queueRef = useRef<PlayerTrack[]>([]);
  const queueIndexRef = useRef(-1);
  const progressRef = useRef(0);
  const progressCallbacksRef = useRef<Set<(p: number) => void>>(new Set());
  const seekFnRef = useRef<((ratio: number) => void) | null>(null);

  const currentTrack = queueIndex >= 0 ? (queue[queueIndex] ?? null) : null;

  const setQueueState = useCallback((tracks: PlayerTrack[], index: number) => {
    queueRef.current = tracks;
    queueIndexRef.current = index;
    setQueue(tracks);
    setQueueIndex(index);
  }, []);

  const playQueue = useCallback(
    (tracks: PlayerTrack[], index: number) => {
      if (tracks.length === 0 || index < 0 || index >= tracks.length) return;
      setQueueState(tracks, index);
      setIsPlaying(true);
    },
    [setQueueState],
  );

  const load = useCallback(
    (track: PlayerTrack) => {
      setQueueState([track], 0);
      setIsPlaying(false);
    },
    [setQueueState],
  );

  const play = useCallback(
    (track: PlayerTrack) => {
      setQueueState([track], 0);
      setIsPlaying(true);
    },
    [setQueueState],
  );

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(
    (track?: PlayerTrack) => {
      const current =
        queueIndexRef.current >= 0
          ? (queueRef.current[queueIndexRef.current] ?? null)
          : null;
      if (track && !sameTrack(track, current)) {
        setQueueState([track], 0);
        setIsPlaying(true);
      } else {
        setIsPlaying((prev) => !prev);
      }
    },
    [setQueueState],
  );

  const stop = useCallback(() => {
    setIsPlaying(false);
    setQueueState([], -1);
  }, [setQueueState]);

  const seek = useCallback((ratio: number) => {
    seekFnRef.current?.(ratio);
  }, []);

  const next = useCallback(() => {
    const nextIdx = queueIndexRef.current + 1;
    if (nextIdx < 0 || nextIdx >= queueRef.current.length) return;
    queueIndexRef.current = nextIdx;
    setQueueIndex(nextIdx);
    setIsPlaying(true);
  }, []);

  const previous = useCallback(() => {
    if (progressRef.current * (duration || 0) > 3) {
      seekFnRef.current?.(0);
      return;
    }
    const prevIdx = queueIndexRef.current - 1;
    if (prevIdx < 0) {
      seekFnRef.current?.(0);
      return;
    }
    queueIndexRef.current = prevIdx;
    setQueueIndex(prevIdx);
    setIsPlaying(true);
  }, [duration]);

  const reportProgress = useCallback((p: number) => {
    progressRef.current = p;
    progressCallbacksRef.current.forEach((fn) => fn(p));
  }, []);

  const subscribeProgress = useCallback((fn: (p: number) => void) => {
    progressCallbacksRef.current.add(fn);
    fn(progressRef.current);
    return () => {
      progressCallbacksRef.current.delete(fn);
    };
  }, []);

  const registerSeek = useCallback((fn: ((ratio: number) => void) | null) => {
    seekFnRef.current = fn;
  }, []);

  const reportDuration = useCallback((d: number) => {
    setDuration(d);
  }, []);

  const hasNext = queueIndex >= 0 && queueIndex < queue.length - 1;
  const hasPrevious = queueIndex > 0;
  const peekNext = useCallback((): PlayerTrack | null => {
    const idx = queueIndexRef.current + 1;
    if (idx < 0 || idx >= queueRef.current.length) return null;
    return queueRef.current[idx] ?? null;
  }, []);

  const value = useMemo<PlayerContextValue>(
    () => ({
      currentTrack,
      isPlaying,
      load,
      play,
      playQueue,
      pause,
      toggle,
      stop,
      seek,
      next,
      previous,
      peekNext,
      hasNext,
      hasPrevious,
      reportProgress,
      subscribeProgress,
      registerSeek,
      duration,
      reportDuration,
    }),
    [
      currentTrack,
      isPlaying,
      load,
      play,
      playQueue,
      pause,
      toggle,
      stop,
      seek,
      next,
      previous,
      peekNext,
      hasNext,
      hasPrevious,
      reportProgress,
      subscribeProgress,
      registerSeek,
      duration,
      reportDuration,
    ],
  );

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within a PlayerProvider");
  return ctx;
}
