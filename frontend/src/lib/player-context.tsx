'use client';

import { createContext, useContext, useState, useCallback } from 'react';

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
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

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

  return (
    <PlayerContext.Provider value={{ currentTrack, isPlaying, load, play, pause, toggle, stop }}>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
  return ctx;
}
