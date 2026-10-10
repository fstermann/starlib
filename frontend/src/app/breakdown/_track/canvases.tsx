"use client";

import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef } from "react";

import { WAVEFORM_BLOCK, type Waveform } from "@/lib/stem-player";
import { barStartS, noteAt, type Grid } from "@/lib/track-breakdown";

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

function xToHz(x: number, width: number): number {
  return MIN_HZ * (MAX_HZ / MIN_HZ) ** (x / width);
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
  clock,
  delay,
}: {
  analyser: () => AnalyserNode | null;
  playing: boolean;
  /** The audio clock, in seconds. */
  clock: () => number;
  /** Seconds to hold frames back so the display matches what you hear. */
  delay: () => number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const bins = useRef<Float32Array<ArrayBuffer> | null>(null);
  const frames = useRef<SpectrumFrame[]>([]);
  const hoverX = useRef<number | null>(null);

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

    const hover = hoverX.current;
    const level =
      hover === null || !node || !bins.current
        ? null
        : levelAt(
            bins.current,
            node.context.sampleRate / node.fftSize,
            xToHz(hover, width),
          );
    if (hover !== null) drawHover(ctx, hover, width, height, level);
    updateReadout(readoutRef.current, hover, width, level);

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
    ctx.fillStyle = token("--brand-soft");
    ctx.fill();
    ctx.strokeStyle = token("--brand");
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
        const now = clock();
        const frame = new Float32Array(node.frequencyBinCount);
        node.getFloatFrequencyData(frame);
        frames.current.push({ time: now, bins: frame });
        bins.current = heardFrame(frames.current, now - delay());
      }
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser, clock, delay, draw, playing]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={ref}
        className="block h-full w-full cursor-crosshair"
        data-testid="track-spectrum"
        onPointerMove={(e) => {
          hoverX.current =
            e.clientX - e.currentTarget.getBoundingClientRect().left;
          draw();
        }}
        onPointerLeave={() => {
          hoverX.current = null;
          draw();
        }}
      />
      <div
        ref={readoutRef}
        className="pointer-events-none absolute top-2 hidden rounded-sm border border-[var(--border-strong)] bg-[var(--surface-1)] px-1.5 py-0.5 text-right font-mono text-xs leading-4 text-[var(--text)] tabular-nums"
        data-testid="track-spectrum-readout"
      />
    </div>
  );
}

type SpectrumFrame = { time: number; bins: Float32Array<ArrayBuffer> };

/**
 * The newest frame captured by `heardAt`, dropping older ones; frames stay
 * queued while they're still ahead of what you hear.
 */
function heardFrame(
  frames: SpectrumFrame[],
  heardAt: number,
): Float32Array<ArrayBuffer> {
  while (frames.length > 1 && frames[1].time <= heardAt) frames.shift();
  return frames[0].bins;
}

/** Spectrum level in dB at `hz`, from the nearest FFT bin. */
function levelAt(bins: Float32Array, hzPerBin: number, hz: number): number {
  const i = Math.min(bins.length - 1, Math.max(1, Math.round(hz / hzPerBin)));
  return bins[i];
}

function drawHover(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  height: number,
  level: number | null,
) {
  ctx.strokeStyle = token("--text-muted");
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, height);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (level === null || !Number.isFinite(level) || level < MIN_DB) return;
  ctx.fillStyle = token("--brand");
  ctx.beginPath();
  ctx.arc(x, dbToY(Math.min(level, MAX_DB), height), 3, 0, Math.PI * 2);
  ctx.fill();
}

/** Writes Hz, note and level next to the pointer, flipping left near the right edge. */
function updateReadout(
  el: HTMLDivElement | null,
  x: number | null,
  width: number,
  level: number | null,
) {
  if (!el) return;
  if (x === null) {
    el.style.display = "none";
    return;
  }
  const hz = xToHz(x, width);
  const lines = [
    `${hz < 1000 ? hz.toFixed(1) : (hz / 1000).toFixed(2) + "k"} Hz`,
    noteAt(hz),
  ];
  if (level !== null && Number.isFinite(level) && level >= MIN_DB)
    lines.push(`${level.toFixed(1)} dB`);
  el.textContent = "";
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    el.appendChild(row);
  }
  el.style.display = "block";
  const flip = x > width - 96;
  el.style.left = flip ? "" : `${x + 8}px`;
  el.style.right = flip ? `${width - x + 8}px` : "";
}
