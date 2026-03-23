'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import type { FrequencyBand } from '@/hooks/use-frequency-bands';

interface WaveformProps {
  peaks: number[];
  progress: number;        // 0..1 (full-track playhead)
  duration: number;        // seconds
  currentTime: number;     // seconds (zoom centering)
  onSeek: (time: number) => void;
  variant?: 'mono' | 'rgb';
  rgbBands?: FrequencyBand[];
  windowSeconds?: number;  // if set, show a scrolling zoom popup on hover
}

const PLAYED_COLOR = '#e05d38';
const UNPLAYED_COLOR = 'rgba(107,114,128,0.25)';
// Gamma < 1 boosts mid-range values so colors are never near-black
const GAMMA = 0.5;
const ZOOM_CSS_H = 56; // px — height of the floating zoom popup (h-14)

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

export function Waveform({ peaks, progress, duration, currentTime, onSeek, variant = 'mono', rgbBands, windowSeconds }: WaveformProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const sizeRef       = useRef({ width: 0, height: 0 });

  // Keep latest values in refs so stable callbacks can read them without deps
  const peaksRef         = useRef(peaks);
  const progressRef      = useRef(progress);
  const currentTimeRef   = useRef(currentTime);
  const variantRef       = useRef(variant);
  const rgbBandsRef      = useRef(rgbBands);
  const durationRef      = useRef(duration);
  const windowSecondsRef = useRef(windowSeconds);
  const hoverRef         = useRef<number | null>(null); // 0..1

  peaksRef.current         = peaks;
  progressRef.current      = progress;
  currentTimeRef.current   = currentTime;
  variantRef.current       = variant;
  rgbBandsRef.current      = rgbBands;
  durationRef.current      = duration;
  windowSecondsRef.current = windowSeconds;

  const [isHovered, setIsHovered] = useState(false);
  const [tooltip, setTooltip]     = useState<{ pct: number; text: string } | null>(null);

  // ── Main canvas: always full-track overview ─────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: cssW, height: cssH } = sizeRef.current;
    if (cssW === 0 || cssH === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const p     = peaksRef.current;
    const prog  = progressRef.current;
    const mode  = variantRef.current;
    const bands = rgbBandsRef.current;
    const hov   = hoverRef.current;

    if (p.length === 0) { ctx.restore(); return; }

    const cy      = cssH / 2;
    const n       = p.length;
    const bw      = cssW / n;
    const gap     = bw > 2.5 ? 1 : 0;
    const abw     = Math.max(1, bw - gap);
    const playedN = prog * n;
    const radius  = Math.min(abw / 2, 1.5);

    // Pass 1: monochrome
    for (let i = 0; i < n; i++) {
      const x      = i * bw;
      const hh     = Math.max(1.5, p[i] * (cy * 0.85));
      const played = i < playedN;
      ctx.fillStyle = played ? PLAYED_COLOR : UNPLAYED_COLOR;
      ctx.beginPath();
      ctx.roundRect(x, cy - hh, abw, hh * 2, radius);
      ctx.fill();
    }

    // Pass 2: RGB overlay
    if (mode === 'rgb' && bands && bands.length > 0) {
      ctx.globalCompositeOperation = 'source-atop';
      for (let i = 0; i < n; i++) {
        if (i >= bands.length) break;
        const x      = i * bw;
        const hh     = Math.max(1.5, p[i] * (cy * 0.85));
        const played = i < playedN;
        const r = Math.round(Math.pow(bands[i].low,  GAMMA) * 255);
        const g = Math.round(Math.pow(bands[i].mid,  GAMMA) * 220);
        const b = Math.round(Math.pow(bands[i].high, GAMMA) * 255);
        ctx.fillStyle = played ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},0.55)`;
        ctx.beginPath();
        ctx.roundRect(x, cy - hh, abw, hh * 2, radius);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Playhead
    const headX = prog * cssW;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(headX - 0.5, 0, 1, cssH);

    // Hover line
    if (hov !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(hov * cssW - 0.5, 0, 1, cssH);
    }

    ctx.restore();
  }, []);

  // ── Zoom canvas: scrolling window, shown in floating popup on hover ─────────
  const drawZoom = useCallback(() => {
    const canvas = zoomCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = sizeRef.current.width;
    const cssH = ZOOM_CSS_H;
    if (cssW === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const p      = peaksRef.current;
    const curr   = currentTimeRef.current;
    const mode   = variantRef.current;
    const bands  = rgbBandsRef.current;
    const dur    = durationRef.current;
    const winSec = windowSecondsRef.current;
    const hov    = hoverRef.current;

    if (p.length === 0 || !winSec || winSec <= 0 || dur <= 0) { ctx.restore(); return; }

    const cy         = cssH / 2;
    const maxH       = cy * 0.92;
    const totalBars  = p.length;
    const barsPerSec = totalBars / dur;
    const halfWin    = (winSec / 2) * barsPerSec;
    const centerBar  = curr * barsPerSec;
    const cssWInt    = Math.ceil(cssW);

    // Pass 1: monochrome
    for (let px = 0; px < cssWInt; px++) {
      const frac   = px / cssW;
      const barF   = centerBar - halfWin + frac * halfWin * 2;
      const i0     = Math.max(0, Math.min(totalBars - 1, Math.floor(barF)));
      const i1     = Math.min(totalBars - 1, i0 + 1);
      const peak   = lerp(p[i0] ?? 0, p[i1] ?? 0, barF - i0);
      const hh     = Math.max(1.5, peak * maxH);
      const played = barF < centerBar;
      ctx.fillStyle = played ? PLAYED_COLOR : UNPLAYED_COLOR;
      ctx.fillRect(px, cy - hh, 1, hh * 2);
    }

    // Pass 2: RGB overlay
    if (mode === 'rgb' && bands && bands.length > 0) {
      ctx.globalCompositeOperation = 'source-atop';
      const bLen = bands.length;
      for (let px = 0; px < cssWInt; px++) {
        const frac  = px / cssW;
        const barF  = centerBar - halfWin + frac * halfWin * 2;
        const bandF = (barF / totalBars) * (bLen - 1);
        const bi0   = Math.max(0, Math.min(bLen - 1, Math.floor(bandF)));
        const bi1   = Math.min(bLen - 1, bi0 + 1);
        const bt    = bandF - bi0;
        const low   = lerp(bands[bi0].low,  bands[bi1].low,  bt);
        const mid   = lerp(bands[bi0].mid,  bands[bi1].mid,  bt);
        const high  = lerp(bands[bi0].high, bands[bi1].high, bt);
        const r = Math.round(Math.pow(low,  GAMMA) * 255);
        const g = Math.round(Math.pow(mid,  GAMMA) * 220);
        const b = Math.round(Math.pow(high, GAMMA) * 255);
        const played = barF < centerBar;
        ctx.fillStyle = played ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},0.55)`;
        ctx.fillRect(px, 0, 1, cssH);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Fixed center playhead
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(cssW / 2 - 0.5, 0, 1, cssH);

    // Hover line
    if (hov !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(hov * cssW - 0.5, 0, 1, cssH);
    }

    ctx.restore();
  }, []);

  // ResizeObserver — triggers both draws
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      sizeRef.current = { width, height };
      draw();
      drawZoom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw, drawZoom]);

  // Redraw on data changes
  useEffect(() => {
    draw();
    drawZoom();
  }, [peaks, progress, currentTime, variant, rgbBands, draw, drawZoom]);

  // Seeking maps from full-track overview position
  const fracToTime = useCallback((frac: number): number => {
    return Math.max(0, Math.min(durationRef.current, frac * durationRef.current));
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect  = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    hoverRef.current = ratio;
    setIsHovered(true);
    draw();
    drawZoom();
    setTooltip({ pct: ratio * 100, text: fmtTime(fracToTime(ratio)) });
  }, [draw, drawZoom, fracToTime]);

  const handleMouseLeave = useCallback(() => {
    hoverRef.current = null;
    setIsHovered(false);
    draw();
    drawZoom();
    setTooltip(null);
  }, [draw, drawZoom]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect  = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(fracToTime(ratio));
  }, [onSeek, fracToTime]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full cursor-pointer"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    >
      {/* Zoom popup — floats above the strip on hover */}
      {windowSeconds && (
        <div
          className={`absolute bottom-full left-0 right-0 mb-2 h-14 bg-black/85 rounded-md overflow-hidden pointer-events-none border border-white/10 shadow-xl z-50 transition-opacity duration-100 ${isHovered ? 'opacity-100' : 'opacity-0'}`}
        >
          <canvas ref={zoomCanvasRef} className="block w-full h-full" />
          {tooltip && (
            <div
              className="absolute top-1 pointer-events-none text-[9px] font-mono text-white/90 bg-black/60 px-1 py-0.5 rounded whitespace-nowrap -translate-x-1/2"
              style={{ left: `clamp(16px, ${tooltip.pct}%, calc(100% - 16px))` }}
            >
              {tooltip.text}
            </div>
          )}
        </div>
      )}

      {/* Main overview canvas */}
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* Tooltip when no zoom popup */}
      {!windowSeconds && tooltip && (
        <div
          className="absolute top-0 pointer-events-none text-[9px] font-mono text-white/90 bg-black/60 px-1 py-0.5 rounded whitespace-nowrap -translate-x-1/2"
          style={{ left: `clamp(16px, ${tooltip.pct}%, calc(100% - 16px))` }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
