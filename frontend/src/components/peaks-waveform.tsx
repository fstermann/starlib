"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface PeaksWaveformProps {
  /** Normalized peaks (0–1), rendered as mirrored bars. */
  peaks: number[];
  /** Playhead position (0–1); the played portion is brand-tinted. */
  progress: number;
  /** Dim the whole render (used to fade the out-going deck during a mix). */
  dim?: number;
  className?: string;
}

/**
 * A minimal, self-contained peaks renderer for the crossfade overlay — no
 * WaveSurfer, no global player coupling (unlike `mini-waveform.tsx`). Draws
 * mirrored bars with the played portion tinted, sized to its container via a
 * ResizeObserver.
 */
export function PeaksWaveform({
  peaks,
  progress,
  dim = 0,
  className,
}: PeaksWaveformProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0 || peaks.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.globalAlpha = 1 - Math.min(1, Math.max(0, dim));

    const isDark = document.documentElement.classList.contains("dark");
    const unplayed = isDark ? "#55566a" : "#b6b6bd";
    const played = "#a8cd49"; // brand — see --brand in globals.css.

    const barW = 2;
    const gap = 1;
    const step = barW + gap;
    const bars = Math.max(1, Math.floor(size.w / step));
    const mid = size.h / 2;
    const playedX = progress * size.w;

    // Match the resting overview's WaveSurfer render: normalize to the tallest
    // peak (`normalize: true`) and take the MAX over each bar's bucket of
    // peaks. Point-sampling one peak per bar systematically undershoots
    // (shorter, spikier bars) — the waveform would visibly shrink the moment
    // this renderer replaces WaveSurfer at the start of a crossfade.
    const maxPeak = peaks.reduce((m, p) => (p > m ? p : m), 0);
    const norm = maxPeak > 0 ? 1 / maxPeak : 1;

    for (let i = 0; i < bars; i++) {
      const x = i * step;
      const start = Math.floor((i / bars) * peaks.length);
      const end = Math.max(
        start + 1,
        Math.floor(((i + 1) / bars) * peaks.length),
      );
      let peak = 0;
      for (let j = start; j < end; j++) {
        const v = peaks[j] ?? 0;
        if (v > peak) peak = v;
      }
      const amp = Math.min(1, Math.max(0, peak * norm));
      const h = Math.max(1, amp * (size.h - 2));
      ctx.fillStyle = x < playedX ? played : unplayed;
      ctx.fillRect(x, mid - h / 2, barW, h);
    }
  }, [peaks, progress, dim, size]);

  return (
    <div ref={wrapRef} className={cn("relative overflow-hidden", className)}>
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
