"use client";

import { Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatTimecode, jobAudioUrl } from "@/lib/analyser";

interface WaveSurferLike {
  play(): Promise<void>;
  pause(): void;
  isPlaying(): boolean;
  seekTo(ratio: number): void;
  destroy(): void;
  getDuration(): number;
  getCurrentTime(): number;
  on(event: string, fn: (arg?: unknown) => void): void;
}

export interface SetAudio {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ready: boolean;
  error: string | null;
  isPlaying: boolean;
  duration: number;
  progressS: number;
  togglePlay: () => void;
  restart: () => void;
  /** Seek the playback head to the given time (clamped to [0, duration]). */
  seek: (seconds: number) => void;
  /** Start playback. No-op when not ready or already playing. */
  play: () => void;
}

/**
 * Loads the cached set audio into a WaveSurfer instance attached to the
 * returned ``containerRef`` and exposes playback state for sibling
 * controls (transport, playhead overlay).
 */
export function useSetAudio(
  jobId: string | null,
  /** Defer WaveSurfer init until the backend has cached the audio. The
   *  caller (the analyser page) flips this to true once the snapshot
   *  reports a non-zero duration — by then ``fetch_audio()`` has run on
   *  the backend so the ``/audio`` endpoint will serve 200 instead of
   *  404'ing during the first BPM pass. */
  enabled: boolean = true,
): SetAudio {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurferLike | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [progressS, setProgressS] = useState(0);

  useEffect(() => {
    if (!jobId || !enabled || !containerRef.current) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setReady(false);
    setError(null);
    setIsPlaying(false);
    setDuration(0);
    setProgressS(0);

    void (async () => {
      try {
        const { default: WaveSurfer } = await import("wavesurfer.js");
        if (cancelled || !containerRef.current) return;
        // WaveSurfer rasterises into <canvas>, which doesn't honour CSS
        // custom properties — pass real OKLCH strings resolved from the
        // root computed style so the colours actually render.
        const cs = getComputedStyle(document.documentElement);
        const colour = (token: string, fallback: string) => {
          const v = cs.getPropertyValue(token).trim();
          return v.length > 0 ? v : fallback;
        };
        const ws = WaveSurfer.create({
          container: containerRef.current,
          height: 56,
          waveColor: colour("--color-text-subtle", "#888"),
          progressColor: colour("--color-brand", "#a0e060"),
          cursorColor: colour("--color-brand-active", "#84c441"),
          cursorWidth: 1,
          barWidth: 2,
          barGap: 1,
          barRadius: 1,
          normalize: true,
          url: jobAudioUrl(jobId),
        });
        wsRef.current = ws as unknown as WaveSurferLike;

        ws.on("ready", () => {
          if (cancelled) return;
          setReady(true);
          setDuration(ws.getDuration());
        });
        ws.on("play", () => setIsPlaying(true));
        ws.on("pause", () => setIsPlaying(false));
        ws.on("finish", () => setIsPlaying(false));
        ws.on("timeupdate", () => setProgressS(ws.getCurrentTime()));
        ws.on("error", ((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "audio load failed");
        }) as () => void);

        teardown = () => {
          try {
            ws.destroy();
          } catch {
            // already torn down — fine
          }
        };
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      teardown?.();
      wsRef.current = null;
    };
  }, [jobId, enabled]);

  const togglePlay = () => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    // Optimistic state flip — keeps the per-row Pause/Play button (and
    // the transport's own button) in sync with the click instead of
    // waiting for WaveSurfer's ``play``/``pause`` events to round-trip.
    if (ws.isPlaying()) {
      ws.pause();
      setIsPlaying(false);
    } else {
      void ws.play();
      setIsPlaying(true);
    }
  };

  const restart = () => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    ws.seekTo(0);
  };

  const seek = (seconds: number) => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    const dur = ws.getDuration();
    if (dur <= 0) return;
    const clamped = Math.max(0, Math.min(dur, seconds));
    ws.seekTo(clamped / dur);
    // Push the seek time into ``progressS`` immediately so consumers
    // (e.g. the tracklist's per-row Play/Pause button via
    // ``playheadIn``) reflect the new position synchronously instead
    // of waiting for WaveSurfer's first ``timeupdate`` event after the
    // seek lands.
    setProgressS(clamped);
  };

  const play = () => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (!ws.isPlaying()) void ws.play();
    // Mirror the optimistic update used by ``seek`` — flip the
    // ``isPlaying`` flag immediately rather than waiting for the
    // ``play`` event to fire on the next animation frame.
    setIsPlaying(true);
  };

  return {
    containerRef,
    ready,
    error,
    isPlaying,
    duration,
    progressS,
    togglePlay,
    restart,
    seek,
    play,
  };
}

/**
 * Compact stacked transport: a single play button on top, current
 * time below. Hovering the time row reveals an inline restart button
 * — keeps the rail uncluttered while the seek-to-zero affordance is
 * still one motion away. Designed for the timeline's left rail.
 */
/** Round play/pause button — same shape and brand fill as the
 *  library's WaveformPlayer. Caller positions it; this component just
 *  fills its parent and centres the button. */
export function SetAudioPlayButton({ audio }: { audio: SetAudio }) {
  const { ready, error, isPlaying, togglePlay } = audio;
  return (
    <button
      type="button"
      disabled={!ready}
      aria-label={isPlaying ? "Pause" : "Play"}
      title={isPlaying ? "Pause" : "Play"}
      onClick={togglePlay}
      data-testid="set-waveform-toggle"
      className="bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active absolute top-1/2 left-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    >
      {!ready && !error ? (
        <Loader2 className="size-3 animate-spin" />
      ) : isPlaying ? (
        <Pause className="size-3" />
      ) : (
        <Play className="size-3 translate-x-px" />
      )}
    </button>
  );
}

/** Current-time readout that crossfades to a restart button on hover.
 *  The two glyphs share the same absolute slot so they swap in place
 *  rather than nudging neighbouring layout. */
export function SetAudioCurrentTime({ audio }: { audio: SetAudio }) {
  const { ready, progressS, restart } = audio;
  return (
    <div className="group absolute inset-0">
      <span
        className="text-text-subtle pointer-events-none absolute inset-0 grid place-items-center text-[10px] leading-none tabular-nums opacity-100 transition-opacity duration-150 group-hover:opacity-0"
        data-testid="set-audio-current-time"
      >
        {formatTimecode(progressS)}
      </span>
      <button
        type="button"
        aria-label="Restart"
        title="Restart"
        onClick={restart}
        disabled={!ready}
        data-testid="set-waveform-restart"
        className="text-text-muted hover:text-text absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
      >
        <RotateCcw className="size-3" />
      </button>
    </div>
  );
}
