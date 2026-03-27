'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface PlayerTrack {
  filePath: string;
  fileName: string;
  title?: string;
  artist?: string;
}

interface PlayerContextValue {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  load: (track: PlayerTrack) => void;
  play: (track: PlayerTrack) => void;
  pause: () => void;
  toggle: (track?: PlayerTrack) => void;
  stop: () => void;
  /** Seek to a position (0–1) in the current track. */
  seek: (ratio: number) => void;
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

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const [duration, setDuration] = useState(0);
  const progressRef = useRef(0);
  const progressCallbacksRef = useRef<Set<(p: number) => void>>(new Set());
  const seekFnRef = useRef<((ratio: number) => void) | null>(null);

  const load = useCallback((track: PlayerTrack) => {
    setCurrentTrack(track);
    setIsPlaying(false);
  }, []);

  const play = useCallback((track: PlayerTrack) => {
    setCurrentTrack(track);
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const toggle = useCallback((track?: PlayerTrack) => {
    if (track && track.filePath !== currentTrack?.filePath) {
      setCurrentTrack(track);
      setIsPlaying(true);
    } else {
      setIsPlaying((prev) => !prev);
    }
  }, [currentTrack]);

  const stop = useCallback(() => {
    setIsPlaying(false);
    setCurrentTrack(null);
  }, []);

  const seek = useCallback((ratio: number) => {
    seekFnRef.current?.(ratio);
  }, []);

  const reportProgress = useCallback((p: number) => {
    progressRef.current = p;
    progressCallbacksRef.current.forEach((fn) => fn(p));
  }, []);

  const subscribeProgress = useCallback((fn: (p: number) => void) => {
    progressCallbacksRef.current.add(fn);
    fn(progressRef.current); // deliver current value immediately
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

  return (
    <PlayerContext.Provider value={{ currentTrack, isPlaying, load, play, pause, toggle, stop, seek, reportProgress, subscribeProgress, registerSeek, duration, reportDuration }}>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
  return ctx;
}
