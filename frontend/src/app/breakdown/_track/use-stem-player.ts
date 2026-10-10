"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { claimPlayback, releasePlayback } from "@/lib/exclusive-audio";
import { getRaw, setRaw } from "@/lib/settings";
import { StemPlayer, type LoopRegion } from "@/lib/stem-player";
import { isTauri, outputLatency } from "@/lib/tauri";
import {
  DRUM_PART_NAMES,
  STEM_NAMES,
  stemUrl,
  type DrumPartName,
} from "@/lib/track-breakdown";

export const ORIGINAL = "original";

/** Drum parts, split from the drums stem by DrumSep; the drums lane is their sum. */
export const DRUM_PARTS = [
  { id: "kick", label: "Kick", hint: "Kick (with any toms)" },
  { id: "snare", label: "Snare", hint: "Snare, claps" },
  { id: "hats", label: "Hats", hint: "Hats, cymbals" },
] as const satisfies readonly {
  id: DrumPartName;
  label: string;
  hint: string;
}[];

/** Lanes with audio of their own; the drums play as their parts. */
export const PLAYED_STEMS = [
  ...DRUM_PART_NAMES,
  ...STEM_NAMES.filter((stem) => stem !== "drums"),
];

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

const HEADPHONE_DELAY_KEY = "breakdown.headphoneDelay";

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
  const [delayed, setDelayedState] = useState(false);
  const delayedRef = useRef(delayed);

  useEffect(() => {
    void getRaw(HEADPHONE_DELAY_KEY, false).then((on) => {
      delayedRef.current = on;
      setDelayedState(on);
    });
  }, []);

  const deviceLatency = useRef<number | null>(null);

  useEffect(() => {
    if (!delayed || !isTauri()) return;
    let cancelled = false;
    const read = () =>
      outputLatency()
        .catch(() => null)
        .then((seconds) => {
          if (!cancelled) deviceLatency.current = seconds;
        });
    void read();
    // Polled so switching output devices is picked up within a second.
    const timer = window.setInterval(read, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [delayed]);

  /** Seconds the playhead and spectrum wait so they match what you hear. */
  const displayDelay = useCallback(
    () =>
      delayedRef.current
        ? (playerRef.current?.outputDelay(deviceLatency.current) ?? 0)
        : 0,
    [],
  );

  const setDelayed = useCallback((on: boolean) => {
    delayedRef.current = on;
    setDelayedState(on);
    void setRaw(HEADPHONE_DELAY_KEY, on);
  }, []);

  useEffect(() => {
    const player = new StemPlayer(
      {
        [ORIGINAL]: originalUrl,
        ...Object.fromEntries(
          PLAYED_STEMS.map((stem) => [stem, stemUrl(digest, stem)]),
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
      { drums: [...DRUM_PART_NAMES] },
    );
    playerRef.current = player;
    player
      .load(PLAYED_STEMS)
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
      const player = playerRef.current;
      if (player) setPosition(player.heardTime(displayDelay()));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [displayDelay, playing]);

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
    (lanes: readonly string[]) =>
      lanes.every((lane) => loaded.has(lane))
        ? (playerRef.current?.waveform([...lanes]) ?? null)
        : null,
    [loaded],
  );

  const analyser = useCallback(() => playerRef.current?.analyser ?? null, []);
  const clock = useCallback(() => playerRef.current?.clock() ?? 0, []);

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
    delayed,
    setDelayed,
    displayDelay,
    clock,
  };
}

export type StemPlayerControls = ReturnType<typeof useStemPlayer>;
