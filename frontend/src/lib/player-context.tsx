"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  SC_BPM_UPDATED_EVENT,
  type ScBpmUpdatedDetail,
} from "@/components/soundcloud-batch-analyze-button";
import { useIsScUnplayable } from "@/lib/sc-unplayable";

export interface PlayerTrack {
  filePath: string;
  fileName: string;
  title?: string;
  artist?: string;
  /** BPM hint provided by the caller when known (local file tag, SC cache,
   * or metadata). Seeds the pitcher's `currentBpm` on track load. */
  bpm?: number | null;
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
  /** Rekordbox track id with an analyzed waveform. When set, the player
   * derives its peaks from the Rekordbox PWV4 preview (a ~2ms fetch)
   * instead of decoding the audio file via ffmpeg. */
  rekordboxId?: string;
}

interface PlayerContextValue {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  /** Load a single track without playing. Replaces the queue with [track]. */
  load: (track: PlayerTrack) => void;
  /** Play a single track. Replaces the queue with [track]. */
  play: (track: PlayerTrack) => void;
  /** Replace the queue with `tracks` and start playback at `index`. When
   * `startRatio` is provided, playback begins at that offset (0–1) — applied
   * as soon as the new track is decoded. */
  playQueue: (
    tracks: PlayerTrack[],
    index: number,
    startRatio?: number,
  ) => void;
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
  /** Detected/known BPM of the current track. Null when unknown. */
  currentBpm: number | null;
  /** Override the current track's BPM (e.g. after a manual or auto detect). */
  setCurrentBpm: (bpm: number | null) => void;
  /** Target BPM the pitcher pitches playback to. Persisted to localStorage. */
  targetBpm: number;
  setTargetBpm: (bpm: number) => void;
  /** When true, playback is pitched to `targetBpm / currentBpm`. Persisted. */
  pitchEnabled: boolean;
  setPitchEnabled: (enabled: boolean) => void;
}

const PITCH_TARGET_KEY = "starlib.pitcher.targetBpm";
const PITCH_ENABLED_KEY = "starlib.pitcher.enabled";
const DEFAULT_TARGET_BPM = 124;

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
  const [currentBpm, setCurrentBpmState] = useState<number | null>(null);
  const [targetBpm, setTargetBpmState] = useState<number>(DEFAULT_TARGET_BPM);
  const [pitchEnabled, setPitchEnabledState] = useState<boolean>(false);

  // Hydrate pitcher prefs from localStorage. Done in an effect to keep SSR
  // safe — the initial server render gets the defaults and the client
  // upgrades on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const rawTarget = window.localStorage.getItem(PITCH_TARGET_KEY);
    if (rawTarget) {
      const parsed = Number(rawTarget);
      if (Number.isFinite(parsed) && parsed > 0) setTargetBpmState(parsed);
    }
    const rawEnabled = window.localStorage.getItem(PITCH_ENABLED_KEY);
    if (rawEnabled === "1") setPitchEnabledState(true);
  }, []);

  const setTargetBpm = useCallback((bpm: number) => {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    setTargetBpmState(bpm);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PITCH_TARGET_KEY, String(bpm));
    }
  }, []);

  const setPitchEnabled = useCallback((enabled: boolean) => {
    setPitchEnabledState(enabled);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PITCH_ENABLED_KEY, enabled ? "1" : "0");
    }
  }, []);

  const setCurrentBpm = useCallback((bpm: number | null) => {
    setCurrentBpmState(bpm);
  }, []);

  const queueRef = useRef<PlayerTrack[]>([]);
  const queueIndexRef = useRef(-1);
  const progressRef = useRef(0);
  const progressCallbacksRef = useRef<Set<(p: number) => void>>(new Set());
  const seekFnRef = useRef<((ratio: number) => void) | null>(null);
  // Seek that was requested before the next track finished decoding. Applied
  // by `registerSeek` once the player wires the real seek fn.
  const pendingSeekRef = useRef<number | null>(null);

  const currentTrack = queueIndex >= 0 ? (queue[queueIndex] ?? null) : null;

  // Re-seed `currentBpm` whenever the loaded track changes. If the caller
  // supplied a `bpm` hint on the PlayerTrack, use it; otherwise reset to
  // unknown so the pitcher shows "Detect" / triggers auto-detect.
  const trackKey = currentTrack?.filePath ?? null;
  useEffect(() => {
    setCurrentBpmState(currentTrack?.bpm ?? null);
    // Only react to track identity, not full object; bpm hint is read from
    // the latest currentTrack at the moment the track changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey]);

  // Stable numeric SC track id for the currently loaded track, or null when
  // it isn't a SoundCloud track. Reused by the BPM-sync and unplayable-skip
  // effects below.
  const currentScId = (() => {
    const k = currentTrack?.streamRefreshKey;
    if (k == null) return null;
    const n = typeof k === "number" ? k : Number(k);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  // Keep `currentBpm` in sync with manual edits/reanalysis from the SC table
  // cells. Without this the pitcher keeps using the stale value and the
  // playback rate doesn't track the user's correction.
  useEffect(() => {
    if (currentScId == null) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ScBpmUpdatedDetail>).detail;
      if (detail?.trackId === currentScId) {
        setCurrentBpmState(detail.bpm);
      }
    };
    window.addEventListener(SC_BPM_UPDATED_EVENT, handler);
    return () => window.removeEventListener(SC_BPM_UPDATED_EVENT, handler);
  }, [currentScId]);

  const setQueueState = useCallback((tracks: PlayerTrack[], index: number) => {
    queueRef.current = tracks;
    queueIndexRef.current = index;
    setQueue(tracks);
    setQueueIndex(index);
  }, []);

  const playQueue = useCallback(
    (tracks: PlayerTrack[], index: number, startRatio?: number) => {
      if (tracks.length === 0 || index < 0 || index >= tracks.length) return;
      // The about-to-unmount player's seek fn isn't valid for the new track,
      // so drop it here. The new fn lands via `registerSeek` once ready.
      seekFnRef.current = null;
      pendingSeekRef.current =
        startRatio != null && startRatio > 0
          ? Math.max(0, Math.min(1, startRatio))
          : null;
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
    const clamped = Math.max(0, Math.min(1, ratio));
    if (seekFnRef.current) {
      seekFnRef.current(clamped);
    } else {
      // Defer until the next track's seek fn is wired by `registerSeek`.
      pendingSeekRef.current = clamped;
    }
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
    if (fn && pendingSeekRef.current != null) {
      const ratio = pendingSeekRef.current;
      pendingSeekRef.current = null;
      fn(ratio);
    }
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

  // Auto-skip the current track when it gets flagged unplayable. Triggers
  // for both pre-play (the queue advanced to a track that was already in
  // the unplayable set) and mid-play (player or pitcher just flagged it
  // after a 403). The unplayable store dedupes repeated `markScUnplayable`
  // calls for the same id, and the effect only re-runs on (track, flag)
  // transitions — so concurrent writers can't trigger a double-skip.
  const currentUnplayable = useIsScUnplayable(currentScId);
  useEffect(() => {
    if (!currentUnplayable || !currentTrack) return;
    const nextIdx = queueIndexRef.current + 1;
    if (nextIdx >= 0 && nextIdx < queueRef.current.length) {
      queueIndexRef.current = nextIdx;
      setQueueIndex(nextIdx);
      setIsPlaying(true);
    } else {
      setIsPlaying(false);
    }
  }, [currentUnplayable, currentTrack]);

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
      currentBpm,
      setCurrentBpm,
      targetBpm,
      setTargetBpm,
      pitchEnabled,
      setPitchEnabled,
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
      currentBpm,
      setCurrentBpm,
      targetBpm,
      setTargetBpm,
      pitchEnabled,
      setPitchEnabled,
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
