"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { cn } from "@/lib/utils";

interface RekordboxWaveformProps {
  trackId: string;
  /** Optional player track. When provided, clicking starts playback / seeks
   * the same way the filesystem MiniWaveform does. */
  track?: PlayerTrack | null;
  /** Called when the user clicks an inactive waveform to start playback. The
   * parent installs queue context here before playback begins. `startRatio`
   * is the 0–1 click offset so playback can start mid-track. Falls back to
   * `toggle(track)` when absent. */
  onStartPlay?: (startRatio?: number) => void;
  className?: string;
  /** Display width in CSS pixels. Backing canvas is scaled by devicePixelRatio. */
  width?: number;
  /** Display height in CSS pixels. */
  height?: number;
}

// PWV4 column count from Rekordbox EXT analysis files.
const SOURCE_COLS = 1200;

// Module-level cache: trackId → 7200-byte PWV4 payload. The same playlist row
// can rerender during scroll/virtualization; refetching each time would spam
// the backend and the browser's own HTTP cache adds latency we don't need.
const cache = new Map<string, Uint8Array | null>();
const inflight = new Map<string, Promise<Uint8Array | null>>();

export async function loadWaveform(
  trackId: string,
): Promise<Uint8Array | null> {
  if (cache.has(trackId)) return cache.get(trackId) ?? null;
  let p = inflight.get(trackId);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(api.getRekordboxWaveformUrl(trackId));
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
      } catch {
        return null;
      }
    })().then((data) => {
      cache.set(trackId, data);
      inflight.delete(trackId);
      return data;
    });
    inflight.set(trackId, p);
  }
  return p;
}

/**
 * Derive normalized amplitude peaks (0–1, one per PWV4 column) from raw
 * entry bytes. Lets the main player reuse Rekordbox's own analysis instead
 * of decoding the audio file via ffmpeg for peaks.
 */
export function pwv4ToPeaks(data: Uint8Array): number[] {
  const cols = Math.min(SOURCE_COLS, Math.floor(data.length / 6));
  const peaks = new Array<number>(cols);
  for (let i = 0; i < cols; i++) {
    const o = i * 6;
    const h = Math.max(
      data[o + 3] & 0x7f,
      data[o + 4] & 0x7f,
      data[o + 5] & 0x7f,
    );
    peaks[i] = h / 127;
  }
  return peaks;
}

/**
 * Inline mirrored RGB waveform matching what Rekordbox renders in its TRACKS
 * list. Decodes the raw PWV4 entry bytes (1200 columns × 6 bytes each), draws
 * bars symmetrically from the vertical centre, and supports the same
 * click-to-seek / hover-cursor interaction as `<MiniWaveform>`.
 */
export function RekordboxWaveform({
  trackId,
  track,
  onStartPlay,
  className,
  width = 96,
  height = 24,
}: RekordboxWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<Uint8Array | null>(null);

  const { currentTrack, subscribeProgress, seek, toggle } = usePlayer();
  const isActive = !!track && currentTrack?.filePath === track.filePath;

  const isActiveRef = useRef(isActive);
  const currentProgressRef = useRef(0);
  const hoverXRef = useRef<number | null>(null);
  useEffect(() => {
    isActiveRef.current = isActive;
  });

  const draw = useCallback(
    (progress: number, hoverX: number | null = null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = width;
      const cssH = height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (data && data.length >= SOURCE_COLS * 6) {
        // Map source columns to display columns. Each css px averages a window
        // so we keep colour & dynamics under downsampling.
        const step = SOURCE_COLS / cssW;
        const mid = cssH / 2;
        const halfH = cssH / 2;
        for (let x = 0; x < cssW; x++) {
          const start = Math.floor(x * step);
          const end = Math.max(start + 1, Math.floor((x + 1) * step));
          let r = 0,
            g = 0,
            b = 0,
            h = 0,
            n = 0;
          for (let i = start; i < end && i < SOURCE_COLS; i++) {
            const o = i * 6;
            const d3 = data[o + 3] & 0x7f;
            const d4 = data[o + 4] & 0x7f;
            const d5 = data[o + 5] & 0x7f;
            r += d3;
            g += d4;
            b += d5;
            h += Math.max(d5, d3, d4);
            n++;
          }
          if (n === 0) continue;
          r = (r / n / 127) * 255;
          g = (g / n / 127) * 255;
          b = (b / n / 127) * 255;
          const norm = h / n / 127; // 0..1
          const barH = Math.max(1, Math.round(norm * halfH));
          ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
          // Mirrored from the centre — top and bottom halves.
          ctx.fillRect(x, mid - barH, 1, barH * 2);
        }
      }

      // Played overlay: tints columns up to current progress when the track is
      // playing. Keeps the colour signature visible but desaturates the rest.
      const active = isActiveRef.current;
      if (active && progress > 0) {
        const playedX = Math.round(progress * cssW);
        ctx.save();
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.fillRect(0, 0, playedX, cssH);
        ctx.restore();
      }

      // Hover cursor (matches MiniWaveform's affordance).
      if (hoverX !== null) {
        const isDark = document.documentElement.classList.contains("dark");
        ctx.save();
        ctx.fillStyle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";
        ctx.fillRect(0, 0, hoverX, cssH);
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hoverX + 0.5, 0);
        ctx.lineTo(hoverX + 0.5, cssH);
        ctx.stroke();
        ctx.restore();
      }
    },
    [data, width, height],
  );

  useEffect(() => {
    let cancelled = false;
    loadWaveform(trackId).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  // Redraw whenever the painted data or the active track changes, and
  // subscribe to live progress while this track is playing.
  useEffect(() => {
    if (!isActive) {
      currentProgressRef.current = 0;
      draw(0, hoverXRef.current);
      return;
    }
    return subscribeProgress((p) => {
      currentProgressRef.current = p;
      draw(p, hoverXRef.current);
    });
  }, [isActive, subscribeProgress, draw]);

  const playable = !!track;

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!playable) return;
      const rect = e.currentTarget.getBoundingClientRect();
      hoverXRef.current = e.clientX - rect.left;
      draw(currentProgressRef.current, hoverXRef.current);
    },
    [draw, playable],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverXRef.current === null) return;
    hoverXRef.current = null;
    draw(currentProgressRef.current, null);
  }, [draw]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!playable || !track) return;
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      if (isActive) {
        seek(frac);
      } else if (onStartPlay) {
        onStartPlay(frac);
      } else {
        toggle(track);
        // Player queues the pending seek and applies it once the new track
        // finishes decoding.
        if (frac > 0) seek(frac);
      }
    },
    [isActive, seek, toggle, track, onStartPlay, playable],
  );

  return (
    <canvas
      ref={canvasRef}
      className={cn("block", playable && "cursor-pointer", className)}
      style={{ width, height }}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      aria-hidden
    />
  );
}
