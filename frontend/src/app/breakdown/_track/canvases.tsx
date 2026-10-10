"use client";

import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef } from "react";

import { WAVEFORM_BLOCK, type Waveform } from "@/lib/stem-player";
import { barStartS, type Grid } from "@/lib/track-breakdown";

import type { View } from "./lanes";

const MIN_HZ = 20;
const MAX_HZ = 20_000;
const MIN_DB = -96;
const MAX_DB = -6;
const FREQ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10_000];
const DB_LINES = [-24, -48, -72];
/** Narrowest spacing at which grid lines are drawn. */
const MIN_GRID_PX = 6;

/** Resolve a CSS custom property to a colour the canvas understands. */
function token(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Size the canvas backing store to its box at device pixel ratio; returns CSS size. */
function fit(canvas: HTMLCanvasElement): { width: number; height: number } {
  const { width, height } = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr))
    canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr))
    canvas.height = Math.round(height * dpr);
  canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function drawSixteenths(
  ctx: CanvasRenderingContext2D,
  view: View,
  beatsPerBar: number,
  width: number,
  height: number,
) {
  const beatPx = width / (view.span * beatsPerBar);
  // 16ths once they are far enough apart to read, otherwise beats only.
  const perBeat = beatPx / 4 >= MIN_GRID_PX ? 4 : 1;
  const perBar = beatsPerBar * perBeat;
  const first = Math.ceil((view.start - 1) * perBar);
  const last = Math.floor((view.start - 1 + view.span) * perBar);
  const sixteenth = token("--border");
  const beat = token("--border-strong");
  for (let i = first; i <= last; i++) {
    const x = Math.round(((i / perBar + 1 - view.start) / view.span) * width);
    ctx.fillStyle = i % perBeat === 0 ? beat : sixteenth;
    ctx.fillRect(x, 0, 1, height);
  }
}

/** Redraw on resize and theme change. */
function useRedraw(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  draw: () => void,
) {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    draw();
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvas, draw, resolvedTheme]);
}

/**
 * Waveform for the visible bars, on a fixed full-scale axis so lanes compare.
 * Peaks are drawn translucent and RMS solid; without `color` it uses text greys.
 */
export function WaveformLane({
  view,
  grid,
  waveform,
  color,
  showGrid = false,
  testId = "track-waveform",
}: {
  view: View;
  grid: Grid;
  waveform: Waveform | null;
  color?: string;
  /** Draw 16th-note lines, stronger on beats. */
  showGrid?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas || !waveform) return;
    const { width, height } = fit(canvas);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    if (showGrid) drawSixteenths(ctx, view, grid.beats_per_bar, width, height);
    const startS = barStartS(grid, view.start);
    const spanS = view.span * grid.bar_s;
    const nBlocks = waveform.blocks.length / 2;
    const mid = height / 2;
    const fill = color && token(color.replace(/^var\((.+)\)$/, "$1"));
    const peak = fill || token("--text-subtle");
    const body = fill || token("--text-muted");
    const peakAlpha = fill ? 0.45 : 1;
    for (let x = 0; x < width; x++) {
      const from = Math.floor((startS + (x / width) * spanS) / waveform.blockS);
      const to = Math.max(
        from + 1,
        Math.floor((startS + ((x + 1) / width) * spanS) / waveform.blockS),
      );
      if (to <= 0 || from >= nBlocks) continue;
      let min = 0;
      let max = 0;
      let sumSq = 0;
      const first = Math.max(0, from);
      const last = Math.min(nBlocks, to);
      for (let b = first; b < last; b++) {
        min = Math.min(min, waveform.blocks[2 * b]);
        max = Math.max(max, waveform.blocks[2 * b + 1]);
        sumSq += waveform.energy[b];
      }
      const top = mid - Math.min(1, max) * mid;
      const bottom = mid - Math.max(-1, min) * mid;
      ctx.fillStyle = peak;
      ctx.globalAlpha = peakAlpha;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      ctx.globalAlpha = 1;
      const rms = Math.min(
        1,
        Math.sqrt(sumSq / ((last - first) * WAVEFORM_BLOCK)),
      );
      ctx.fillStyle = body;
      ctx.fillRect(x, mid - rms * mid, 1, Math.max(1, 2 * rms * mid));
    }
  }, [color, grid, showGrid, view, waveform]);

  useRedraw(ref, draw);

  return (
    <canvas ref={ref} className="block h-full w-full" data-testid={testId} />
  );
}

function hzToX(hz: number, width: number): number {
  return (Math.log10(hz / MIN_HZ) / Math.log10(MAX_HZ / MIN_HZ)) * width;
}

function dbToY(db: number, height: number): number {
  return ((MAX_DB - db) / (MAX_DB - MIN_DB)) * height;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/**
 * Live spectrum of what is playing, on a log-frequency axis like an EQ
 * plugin. Follows mute and solo, so soloing a stem shows its spectrum.
 */
export function SpectrumPanel({
  analyser,
  playing,
}: {
  analyser: () => AnalyserNode | null;
  playing: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bins = useRef<Float32Array<ArrayBuffer> | null>(null);

  const draw = useCallback(() => {
    const canvas = ref.current;
    const node = analyser();
    if (!canvas) return;
    const { width, height } = fit(canvas);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = token("--border");
    ctx.fillStyle = token("--text-subtle");
    ctx.font = "10px Inter, sans-serif";
    ctx.lineWidth = 1;
    for (const hz of FREQ_LINES) {
      const x = Math.round(hzToX(hz, width)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(formatHz(hz), x + 3, height - 4);
    }
    for (const db of DB_LINES) {
      const y = Math.round(dbToY(db, height)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(`${db} dB`, 4, y - 3);
    }

    if (!node || !bins.current) return;
    const hzPerBin = node.context.sampleRate / node.fftSize;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 1; i < bins.current.length; i++) {
      const hz = i * hzPerBin;
      if (hz < MIN_HZ || hz > MAX_HZ) continue;
      ctx.lineTo(
        hzToX(hz, width),
        dbToY(Math.max(MIN_DB, bins.current[i]), height),
      );
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    const line = token("--chart-1");
    ctx.fillStyle = line;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [analyser]);

  useRedraw(ref, draw);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const node = analyser();
      if (node) {
        if (bins.current?.length !== node.frequencyBinCount)
          bins.current = new Float32Array(node.frequencyBinCount);
        node.getFloatFrequencyData(bins.current);
      }
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser, draw, playing]);

  return (
    <canvas
      ref={ref}
      className="block h-full w-full"
      data-testid="track-spectrum"
    />
  );
}
