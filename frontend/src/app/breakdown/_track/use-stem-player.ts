"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { claimPlayback, releasePlayback } from "@/lib/exclusive-audio";
import { StemPlayer, type LoopRegion } from "@/lib/stem-player";
import { STEM_NAMES, stemUrl } from "@/lib/track-breakdown";

export const ORIGINAL = "original";
export const LANES = [ORIGINAL, ...STEM_NAMES] as const;
export type LaneName = (typeof LANES)[number];

export interface LaneMix {
  volume: number;
  muted: boolean;
  solo: boolean;
}

const PLAYBACK_SLOT = "breakdown-track";

function initialMix(): Record<LaneName, LaneMix> {
  return Object.fromEntries(
    LANES.map((lane) => [
      lane,
      { volume: 1, muted: lane === ORIGINAL, solo: false },
    ]),
  ) as Record<LaneName, LaneMix>;
}

/** Effective gain per lane: soloed lanes only when any is soloed, else unmuted ones. */
export function laneGains(
  mix: Record<LaneName, LaneMix>,
): Record<LaneName, number> {
  const anySolo = LANES.some((lane) => mix[lane].solo);
  return Object.fromEntries(
    LANES.map((lane) => {
      const { volume, muted, solo } = mix[lane];
      const audible = anySolo ? solo : !muted;
      return [lane, audible ? volume : 0];
    }),
  ) as Record<LaneName, number>;
}

/** Synced stem + original playback for one analysed track. */
export function useStemPlayer(digest: string, originalUrl: string) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const [mix, setMix] = useState(initialMix);
  const playerRef = useRef<StemPlayer | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const player = new StemPlayer(
      {
        [ORIGINAL]: originalUrl,
        ...Object.fromEntries(
          STEM_NAMES.map((stem) => [stem, stemUrl(digest, stem)]),
        ),
      },
      () => {
        setPlaying(false);
        setPosition(0);
        releasePlayback(PLAYBACK_SLOT);
      },
    );
    playerRef.current = player;
    player
      .load([...STEM_NAMES])
      .then(() => {
        if (playerRef.current === player) setReady(true);
      })
      .catch((err: unknown) => {
        if (playerRef.current === player) setError(String(err));
      });
    return () => {
      releasePlayback(PLAYBACK_SLOT);
      player.destroy();
      playerRef.current = null;
    };
  }, [digest, originalUrl]);

  useEffect(() => {
    playerRef.current?.setGains(laneGains(mix));
  }, [mix, digest, originalUrl]);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      if (playerRef.current) setPosition(playerRef.current.currentTime());
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [playing]);

  const pause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    player.pause();
    setPlaying(false);
    setPosition(player.currentTime());
    releasePlayback(PLAYBACK_SLOT);
  }, []);

  const play = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;
    claimPlayback(PLAYBACK_SLOT, () => {
      player.pause();
      setPlaying(false);
    });
    await player.play();
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => {
    if (playerRef.current?.playing) pause();
    else void play();
  }, [pause, play]);

  const seek = useCallback((seconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    player.seek(seconds);
    setPosition(player.currentTime());
  }, []);

  const setLoop = useCallback((region: LoopRegion | null) => {
    const player = playerRef.current;
    if (!player) return;
    player.setLoop(region);
    setLoopState(region);
    setPosition(player.currentTime());
  }, []);

  const waveform = useCallback(
    () =>
      ready ? (playerRef.current?.waveform([...STEM_NAMES]) ?? null) : null,
    [ready],
  );

  const analyser = useCallback(() => playerRef.current?.analyser ?? null, []);

  const updateLane = useCallback(
    (lane: LaneName, change: Partial<LaneMix>) =>
      setMix((prev) => ({ ...prev, [lane]: { ...prev[lane], ...change } })),
    [],
  );

  return {
    ready,
    error,
    playing,
    position,
    loop,
    mix,
    play,
    pause,
    toggle,
    seek,
    setLoop,
    updateLane,
    waveform,
    analyser,
  };
}

export type StemPlayerControls = ReturnType<typeof useStemPlayer>;
