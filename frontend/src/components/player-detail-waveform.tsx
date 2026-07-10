"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadWaveform } from "@/components/rekordbox-waveform";
import { api } from "@/lib/api";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import {
  getCachedRekordboxAnalysis,
  type TrackAnalysis,
} from "@/lib/rekordbox-analysis";
import type { WaveformStyle } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  barSpanSeconds,
  buildDownbeatPrefix,
  decodeFloatPeaks,
  decodePwv3,
  decodePwv5,
  rgbCss,
  type DetailWave,
} from "@/lib/waveform-detail";

interface PlayerDetailWaveformProps {
  track: PlayerTrack;
  /** Bars visible across the strip (rekordbox playhead-centred zoom). */
  zoomBars: number;
  /** Track length in seconds. */
  durationSec: number;
  /** Detected BPM, for the bars→seconds mapping. */
  bpm: number | null;
  /** Selected waveform style; picks colour vs blue detail for rekordbox tracks. */
  waveformStyle: WaveformStyle;
  className?: string;
}

/**
 * The zoomed, scrolling waveform strip. The playhead is fixed at the horizontal
 * centre and the waveform scrolls beneath it, rekordbox-style. Draws the
 * high-resolution detail waveform plus, for rekordbox tracks, the beatgrid and
 * cue markers. Phrase sections are shown on the full-track overview instead.
 * WaveSurfer (in the parent) stays the audio/progress driver; this component
 * only reads progress and paints.
 */
export function PlayerDetailWaveform({
  track,
  zoomBars,
  durationSec,
  bpm,
  waveformStyle,
  className,
}: PlayerDetailWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wave, setWave] = useState<DetailWave | null>(null);
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const { subscribeProgress, seek } = usePlayer();
  const progressRef = useRef(0);
  const draggingRef = useRef(false);

  const isRek = !!track.rekordboxId;
  const detailVariant =
    waveformStyle === "rekordbox_blue" ? "blue_detail" : "color_detail";

  // Load the detail waveform for this track (rekordbox PWV5/PWV3 bytes, or the
  // backend's high-resolution ffmpeg peaks for a local file).
  useEffect(() => {
    let cancelled = false;
    if (isRek && track.rekordboxId) {
      loadWaveform(
        track.rekordboxId,
        track.rekordboxDevice,
        detailVariant,
      ).then((bytes) => {
        if (cancelled) return;
        setWave(
          !bytes
            ? null
            : detailVariant === "blue_detail"
              ? decodePwv3(bytes)
              : decodePwv5(bytes),
        );
      });
    } else if (durationSec > 0) {
      const numPeaks = Math.max(
        50,
        Math.min(50000, Math.round(durationSec * 150)),
      );
      api
        .getFilePeaks(track.filePath, numPeaks)
        .then((peaks) => {
          if (!cancelled) setWave(decodeFloatPeaks(peaks, durationSec));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [
    isRek,
    track.rekordboxId,
    track.rekordboxDevice,
    track.filePath,
    detailVariant,
    durationSec,
  ]);

  // Load beatgrid / sections / cues (rekordbox only). Non-rekordbox tracks
  // resolve to `null` so a previous track's grid never bleeds through.
  useEffect(() => {
    let cancelled = false;
    const p =
      isRek && track.rekordboxId
        ? getCachedRekordboxAnalysis(track.rekordboxId, track.rekordboxDevice)
        : Promise.resolve(null);
    p.then((a) => {
      if (!cancelled) setAnalysis(a);
    });
    return () => {
      cancelled = true;
    };
  }, [isRek, track.rekordboxId, track.rekordboxDevice]);

  const downbeatPrefix = useMemo(
    () => buildDownbeatPrefix(analysis?.beatgrid ?? []),
    [analysis],
  );

  // Track the wrapper's pixel box so the canvas fills the fluid player width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(
    (progress: number) => {
      const canvas = canvasRef.current;
      const { w: cssW, h: cssH } = size;
      if (!canvas || cssW === 0 || cssH === 0 || durationSec <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const isDark = document.documentElement.classList.contains("dark");

      const waveTop = 0;
      const waveH = cssH;
      const mid = waveH / 2;
      const halfH = waveH / 2;

      const span = barSpanSeconds(zoomBars, bpm); // seconds across the strip
      const t = progress * durationSec; // playhead time (s)
      const pps = cssW / span; // pixels per second
      const timeToX = (sec: number) => cssW / 2 + (sec - t) * pps;

      // --- waveform columns ---
      if (wave) {
        const cps = wave.columnsPerSecond;
        const first = Math.max(0, Math.floor((t - span / 2) * cps));
        const last = Math.min(
          wave.heights.length - 1,
          Math.ceil((t + span / 2) * cps),
        );
        const colW = Math.max(1, pps / cps);
        const themed = isDark ? "#8888aa" : "#909091";
        for (let i = first; i <= last; i++) {
          const x = timeToX(i / cps);
          const barH = Math.max(1, wave.heights[i] * halfH);
          ctx.fillStyle = wave.colors ? rgbCss(wave.colors[i]) : themed;
          ctx.fillRect(x, mid - barH, colW, barH * 2);
        }
      }

      // --- beat grid (rekordbox only); downbeats are emphasised + numbered ---
      if (analysis?.beatgrid.length) {
        ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = "top";
        for (let i = 0; i < analysis.beatgrid.length; i++) {
          const b = analysis.beatgrid[i];
          const x = timeToX(b.timeMs / 1000);
          if (x < 0 || x > cssW) continue;
          const down = b.beat === 1;
          ctx.strokeStyle = down
            ? isDark
              ? "rgba(255,255,255,0.45)"
              : "rgba(0,0,0,0.4)"
            : isDark
              ? "rgba(255,255,255,0.16)"
              : "rgba(0,0,0,0.14)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, waveTop);
          ctx.lineTo(x + 0.5, cssH);
          ctx.stroke();
          if (down) {
            ctx.fillStyle = isDark
              ? "rgba(255,255,255,0.5)"
              : "rgba(0,0,0,0.45)";
            ctx.fillText(String(downbeatPrefix[i]), x + 2, cssH - 10);
          }
        }
      }

      // --- cue markers ---
      if (analysis?.cues.length) {
        for (const c of analysis.cues) {
          const x = timeToX(c.timeMs / 1000);
          if (x < -6 || x > cssW + 6) continue;
          ctx.fillStyle = c.color ?? (c.type === "hot" ? "#f97316" : "#f43f5e");
          ctx.beginPath();
          ctx.moveTo(x, waveTop);
          ctx.lineTo(x - 4, waveTop);
          ctx.lineTo(x, waveTop + 5);
          ctx.closePath();
          ctx.fill();
          ctx.fillRect(x - 0.5, waveTop, 1, waveH);
          if (c.type === "hot" && c.index != null) {
            ctx.font = "8px ui-sans-serif, system-ui, sans-serif";
            ctx.textBaseline = "top";
            ctx.fillText(String(c.index), x + 2, waveTop + 1);
          }
        }
      }

      // --- centre playhead ---
      ctx.strokeStyle = isDark ? "#d0fd5a" : "#a8cd49";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cssW / 2, 0);
      ctx.lineTo(cssW / 2, cssH);
      ctx.stroke();
    },
    [size, durationSec, zoomBars, bpm, wave, analysis, downbeatPrefix],
  );

  // Redraw on data/size change and subscribe to live progress.
  useEffect(() => {
    draw(progressRef.current);
    return subscribeProgress((p) => {
      progressRef.current = p;
      draw(p);
    });
  }, [draw, subscribeProgress]);

  // Seek by grabbing the waveform: initial press jumps to the time under the
  // cursor, then dragging scrubs relative to pointer movement.
  const seekToClientX = useCallback(
    (clientX: number, rect: DOMRect) => {
      const span = barSpanSeconds(zoomBars, bpm);
      const pps = rect.width / span;
      const dx = clientX - rect.left - rect.width / 2;
      const time = progressRef.current * durationSec + dx / pps;
      if (durationSec > 0) seek(Math.max(0, Math.min(1, time / durationSec)));
    },
    [zoomBars, bpm, durationSec, seek],
  );

  const lastXRef = useRef(0);
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      lastXRef.current = e.clientX;
      seekToClientX(e.clientX, e.currentTarget.getBoundingClientRect());
    },
    [seekToClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!draggingRef.current || durationSec <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const span = barSpanSeconds(zoomBars, bpm);
      const pps = rect.width / span;
      const dx = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      const time = progressRef.current * durationSec - dx / pps;
      seek(Math.max(0, Math.min(1, time / durationSec)));
    },
    [zoomBars, bpm, durationSec, seek],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <div ref={wrapRef} className={cn("size-full", className)}>
      <canvas
        ref={canvasRef}
        className="block size-full cursor-ew-resize touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        aria-hidden
      />
    </div>
  );
}
