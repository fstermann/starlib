"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { claimPlayback, releasePlayback } from "@/lib/exclusive-audio";
import { StemPlayer, type Band, type LoopRegion } from "@/lib/stem-player";
import { STEM_NAMES, stemUrl } from "@/lib/track-breakdown";

export const ORIGINAL = "original";

/**
 * The drums stem played as three bands with their own mute, solo and volume.
 * Crossovers at 150 Hz and 3 kHz, so the parts add back up to the drums.
 */
export const DRUM_PARTS = [
  {
    id: "kick",
    label: "Kick",
    hint: "Kick, below 150 Hz",
    band: { lowpassHz: 150 },
  },
  {
    id: "mids",
    label: "Snare",
    hint: "Snare, clap, toms: 150 Hz to 3 kHz",
    band: { highpassHz: 150, lowpassHz: 3000 },
  },
  {
    id: "tops",
    label: "Hats",
    hint: "Hats, cymbals: above 3 kHz",
    band: { highpassHz: 3000 },
  },
] as const satisfies readonly {
  id: string;
  label: string;
  hint: string;
  band: Band;
}[];
export type DrumPart = (typeof DRUM_PARTS)[number]["id"];

export const LANES = [ORIGINAL, ...STEM_NAMES] as const;
const MIX_KEYS = [...LANES, ...DRUM_PARTS.map((p) => p.id)] as const;
export type LaneName = (typeof MIX_KEYS)[number];

export interface LaneMix {
  volume: number;
  muted: boolean;
  solo: boolean;
}

const PLAYBACK_SLOT = "breakdown-track";

function initialMix(): Record<LaneName, LaneMix> {
  return Object.fromEntries(
    MIX_KEYS.map((lane) => [
      lane,
      { volume: 1, muted: lane === ORIGINAL, solo: false },
    ]),
  ) as Record<LaneName, LaneMix>;
}

/**
 * Effective gain per lane and drum part. While anything is soloed only soloed
 * lanes play; soloing a drum part plays the drums with just that part (and
 * any other soloed part). A drum part's gain is applied after the drums'.
 */
export function laneGains(
  mix: Record<LaneName, LaneMix>,
): Record<LaneName, number> {
  const parts = DRUM_PARTS.map((p) => p.id);
  const anyPartSolo = parts.some((part) => mix[part].solo);
  const anySolo = anyPartSolo || LANES.some((lane) => mix[lane].solo);
  const gains = Object.fromEntries(
    LANES.map((lane) => {
      const { volume, muted, solo } = mix[lane];
      const audible = anySolo
        ? solo || (lane === "drums" && anyPartSolo)
        : !muted;
      return [lane, audible ? volume : 0];
    }),
  ) as Record<LaneName, number>;
  for (const part of parts) {
    const { volume, muted, solo } = mix[part];
    gains[part] = !muted && (!anyPartSolo || solo) ? volume : 0;
  }
  return gains;
}

/** Synced stem + original playback for one analysed track. */
export function useStemPlayer(digest: string, originalUrl: string) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);
  const [mix, setMix] = useState(initialMix);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
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
      (name) => {
        if (playerRef.current === player)
          setLoaded((prev) => new Set(prev).add(name));
      },
      {
        drums: DRUM_PARTS.map((part) => ({ name: part.id, band: part.band })),
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

  /** Waveform of the named lanes summed, or `null` until they are all decoded. */
  const waveform = useCallback(
    (lanes: readonly LaneName[]) =>
      lanes.every((lane) => loaded.has(lane))
        ? (playerRef.current?.waveform([...lanes]) ?? null)
        : null,
    [loaded],
  );

  const bandWaveform = useCallback(
    (lane: LaneName, band: Band) =>
      loaded.has(lane)
        ? (playerRef.current?.bandWaveform(lane, band) ?? Promise.resolve(null))
        : Promise.resolve(null),
    [loaded],
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
    bandWaveform,
    analyser,
  };
}

export type StemPlayerControls = ReturnType<typeof useStemPlayer>;
