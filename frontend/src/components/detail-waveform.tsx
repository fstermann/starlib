'use client';

import { useRef, useEffect, useCallback } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { FrequencyBand } from '@/hooks/use-frequency-bands';
import type { BeatAnalysis } from '@/hooks/use-beat-analysis';
interface DetailWaveformProps {
  /** Raw AudioBuffer — sampled per-pixel for true asymmetric waveform. */
  audioBuffer: AudioBuffer | null;
  /** Coarse frequency-band data for RGB coloring (3 000 bars). */
  rgbBands?: FrequencyBand[];
  beatData: BeatAnalysis;
  /** Total track duration in seconds (for seek calculations). */
  duration: number;
  /** Direct ref to the <audio> element — position is read every rAF tick. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onSeek: (time: number) => void;
  bars?: number;
  onBarsChange?: (bars: number) => void;
}

// ── Zoom levels (bars = musical 4-beat bars shown in the window) ────────────
const ZOOM_LEVELS: Array<{ bars: number; label: string }> = [
  { bars: 32,   label: '32 bars' },
  { bars: 16,   label: '16 bars' },
  { bars: 8,    label: '8 bars'  },
  { bars: 4,    label: '4 bars'  },
  { bars: 2,    label: '2 bars'  },
  { bars: 1,    label: '1 bar'   },
  { bars: 0.5,  label: '2 beats' },
  { bars: 0.25, label: '1 beat'  },
];

// ── Visual constants ────────────────────────────────────────────────────────
/** Gamma < 1 boosts mid-range values → vivid, saturated colours. */
const GAMMA            = 0.40;
/** Decimation rate for the low-pass waveform contour (samples/sec). */
const DECIMATE_RATE    = 600;
const BEAT_LINE_COLOR  = 'rgba(255,255,255,0.15)';
const BAR_LINE_COLOR   = 'rgba(255,255,255,0.30)';
const PLAYHEAD_COLOR   = 'rgba(255,255,255,0.95)';
const TRI_H = 6;
const TRI_W = 3;
/** Total canvas height in CSS px. */
const CSS_H      = 96;
/** Pixels reserved at top for triangle markers + bar-number labels. */
const TOP_MARGIN = 14;

// Pre-computed RGBA values for the non-RGB colour modes.
const PLAYED_R = 224, PLAYED_G = 93, PLAYED_B = 56;
const UNPLAYED_R = 107, UNPLAYED_G = 114, UNPLAYED_B = 128;

// Detect CPU byte order once at module load — used for fast Uint32 pixel writes.
// On little-endian (x86, ARM): ImageData RGBA bytes map to R|(G<<8)|(B<<16)|(A<<24).
const IS_LITTLE_ENDIAN = new Uint32Array(new Uint8Array([1, 0, 0, 0]).buffer)[0] === 1;

// Gamma lookup table — maps 0..255 input to gamma-corrected 0..255 output.
// Built once at module load; avoids Math.pow in the per-pixel hot loop.
const GAMMA_LUT_R = new Uint8Array(256);
const GAMMA_LUT_G = new Uint8Array(256);
const GAMMA_LUT_B = new Uint8Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    GAMMA_LUT_R[i] = Math.round(Math.pow(v, GAMMA) * 255);
    GAMMA_LUT_G[i] = Math.round(Math.pow(v, GAMMA) * 220);
    GAMMA_LUT_B[i] = Math.round(Math.pow(v, GAMMA) * 255);
  }
})();

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function DetailWaveform({
  audioBuffer,
  rgbBands,
  beatData,
  duration,
  audioRef,
  onSeek,
  bars = 16,
  onBarsChange,
}: DetailWaveformProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tooltip DOM ref — updated directly, no React state, no re-renders.
  const tooltipRef   = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number>(0);
  const sizeRef      = useRef({ width: 0 });
  // Physical pixel size — only written by ResizeObserver, never inside draw().
  const physRef      = useRef({ pxW: 0, pxH: 0 });
  // Cached ImageData buffer — reused every frame, only reallocated on resize.
  const imgRef       = useRef<ImageData | null>(null);

  // Dirty flag — draw() is skipped when false and audio is paused.
  const dirtyRef = useRef(true);

  // Animated zoom: current displayed bars (float), smoothly interpolated toward barsRef.
  const animBarsRef = useRef(bars);

  // Fade-in: ramps 0→1 over 200ms when audioBuffer first becomes available.
  const fadeRef = useRef(0);

  // Cached mono channel data — computed once per audioBuffer change.
  const monoRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null);
  // Low-pass decimated mono for smooth waveform contour rendering.
  const decimatedRef = useRef<{ samples: Float32Array; rate: number } | null>(null);

  // Mutable refs — updated every render, read inside the stable rAF callbacks.
  const audioBufferRef = useRef(audioBuffer);
  const bandsRef    = useRef(rgbBands);
  const beatDataRef = useRef(beatData);
  const durationRef = useRef(duration);
  const barsRef     = useRef(bars);

  // Sync props → refs, and mark dirty on any data change so the canvas redraws.
  if (audioBufferRef.current !== audioBuffer) {
    audioBufferRef.current = audioBuffer;
    // Pre-compute mono mix so draw() just reads a flat Float32Array.
    if (audioBuffer) {
      const numCh = audioBuffer.numberOfChannels;
      const len   = audioBuffer.length;
      const mono  = new Float32Array(len);
      for (let c = 0; c < numCh; c++) {
        const ch = audioBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += ch[i];
      }
      if (numCh > 1) {
        const inv = 1 / numCh;
        for (let i = 0; i < len; i++) mono[i] *= inv;
      }
      monoRef.current = { samples: mono, sampleRate: audioBuffer.sampleRate };

      // Decimate: block-average down to DECIMATE_RATE for smooth contour.
      const blockSize  = Math.max(1, Math.floor(audioBuffer.sampleRate / DECIMATE_RATE));
      const actualRate = audioBuffer.sampleRate / blockSize;
      const numBlocks  = Math.ceil(len / blockSize);
      const dec        = new Float32Array(numBlocks);
      for (let i = 0; i < numBlocks; i++) {
        const s = i * blockSize;
        const e = Math.min(s + blockSize, len);
        let sum = 0;
        for (let j = s; j < e; j++) sum += mono[j];
        dec[i] = sum / (e - s);
      }
      let decMax = 0;
      for (let i = 0; i < numBlocks; i++) {
        const a = Math.abs(dec[i]);
        if (a > decMax) decMax = a;
      }
      if (decMax > 0) {
        const inv = 1 / decMax;
        for (let i = 0; i < numBlocks; i++) dec[i] *= inv;
      }
      decimatedRef.current = { samples: dec, rate: actualRate };
    } else {
      monoRef.current = null;
      decimatedRef.current = null;
    }
    dirtyRef.current = true;
  }
  if (bandsRef.current    !== rgbBands) { bandsRef.current    = rgbBands; dirtyRef.current = true; }
  if (beatDataRef.current !== beatData) { beatDataRef.current = beatData; dirtyRef.current = true; }
  if (durationRef.current !== duration) { durationRef.current = duration; dirtyRef.current = true; }
  if (barsRef.current     !== bars)     { barsRef.current     = bars;     dirtyRef.current = true; }

  // Hover position as a fraction 0..1 — read inside rAF draw(), no re-renders.
  const hoverXRef = useRef<number | null>(null);

  // Drag state — all mutable, no re-renders during the drag itself.
  const dragRef = useRef<{ active: boolean; startX: number; startTime: number; moved: boolean }>({
    active: false, startX: 0, startTime: 0, moved: false,
  });
  // Whether audio was playing when pointer went down — used to resume on pointer up.
  const wasPlayingRef = useRef(false);

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = sizeRef.current.width;
    if (cssW === 0) return;

    // Canvas resize is handled by ResizeObserver — never resize inside draw().
    const { pxW, pxH } = physRef.current;
    if (pxW === 0 || pxH === 0) return;

    const dpr  = window.devicePixelRatio || 1;
    const mono = monoRef.current;
    const fade = fadeRef.current;

    // When there's nothing to draw, clear once and bail.
    if (!mono || durationRef.current <= 0) {
      ctx.clearRect(0, 0, pxW, pxH);
      return;
    }

    const bands   = bandsRef.current;
    const bd      = beatDataRef.current;
    const dur     = durationRef.current;
    const curr    = audioRef.current?.currentTime ?? 0;
    const numBars = animBarsRef.current;

    // ── Window ────────────────────────────────────────────────────────────
    const secPerBeat = 60 / bd.bpm;
    const winSec     = numBars * 4 * secPerBeat;
    const leftTime   = curr - winSec / 2;

    // ── Waveform via ImageData — sample AudioBuffer per-pixel ─────────────
    const samples  = mono.samples;
    const sr       = mono.sampleRate;
    const numSamps = samples.length;
    const bLen     = bands?.length ?? 0;
    const cyPx     = Math.round(((CSS_H + TOP_MARGIN) / 2) * dpr);
    const maxHPx   = ((CSS_H - TOP_MARGIN) / 2) * 0.95 * dpr;

    // Reuse cached ImageData; only reallocate when physical size changes.
    let imgData = imgRef.current;
    if (!imgData || imgData.width !== pxW || imgData.height !== pxH) {
      imgData = ctx.createImageData(pxW, pxH);
      imgRef.current = imgData;
    } else {
      new Uint32Array(imgData.data.buffer).fill(0);
    }

    const buf32 = IS_LITTLE_ENDIAN ? new Uint32Array(imgData.data.buffer) : null;
    const buf   = imgData.data;

    // Decimated buffer for smooth waveform contour.
    const dec     = decimatedRef.current;
    const dSamps  = dec?.samples;
    const dRate   = dec?.rate ?? 1;
    const dLen    = dSamps?.length ?? 0;

    for (let px = 0; px < pxW; px++) {
      // Time range this pixel column covers.
      const t0 = leftTime + (px / pxW) * winSec;
      const t1 = leftTime + ((px + 1) / pxW) * winSec;
      if (t1 < 0 || t0 > dur) continue;

      const timePx = (t0 + t1) / 2;

      // Waveform height: use decimated (low-pass) buffer for smooth contour.
      let topH: number;
      let botH: number;
      if (dSamps && dLen > 1) {
        const tc   = Math.max(0, Math.min(dur, timePx));
        const dIdx = tc * dRate;
        const di0  = Math.max(0, Math.min(dLen - 2, Math.floor(dIdx)));
        const frac = dIdx - di0;
        const v    = dSamps[di0] + (dSamps[di0 + 1] - dSamps[di0]) * frac;
        if (v >= 0) {
          topH = v * maxHPx;
          botH = 0;
        } else {
          topH = 0;
          botH = -v * maxHPx;
        }
      } else {
        // Fallback: min/max envelope from raw samples.
        const s0 = Math.max(0, Math.min(numSamps - 1, Math.floor(Math.max(0, t0) * sr)));
        const s1 = Math.max(s0 + 1, Math.min(numSamps, Math.ceil(Math.min(dur, t1) * sr)));
        let colMax = 0;
        let colMin = 0;
        for (let i = s0; i < s1; i++) {
          const v = samples[i];
          if (v > colMax) colMax = v;
          if (v < colMin) colMin = v;
        }
        topH = Math.max(0.75 * dpr, colMax * maxHPx);
        botH = Math.max(0.75 * dpr, -colMin * maxHPx);
      }

      const played = timePx < curr;

      // Determine column colour.
      let cr: number, cg: number, cb: number;
      let brightAlpha: number, dimAlpha: number;

      if (bands && bLen > 0) {
        const bF  = (timePx / dur) * (bLen - 1);
        const bi0 = Math.max(0, Math.min(bLen - 1, Math.floor(bF)));
        const bi1 = Math.min(bLen - 1, bi0 + 1);
        const bt  = Math.max(0, Math.min(1, bF - bi0));
        const low  = lerp(bands[bi0].low,  bands[bi1].low,  bt);
        const mid  = lerp(bands[bi0].mid,  bands[bi1].mid,  bt);
        const high = lerp(bands[bi0].high, bands[bi1].high, bt);
        cr = GAMMA_LUT_R[Math.round(Math.max(0, Math.min(1, low))  * 255)];
        cg = GAMMA_LUT_G[Math.round(Math.max(0, Math.min(1, mid))  * 255)];
        cb = GAMMA_LUT_B[Math.round(Math.max(0, Math.min(1, high)) * 255)];
        brightAlpha = played ? 1.0 : 0.40;
        dimAlpha    = played ? 0.75 : 0.26;
      } else {
        if (played) {
          cr = PLAYED_R; cg = PLAYED_G; cb = PLAYED_B;
          brightAlpha = 1.0; dimAlpha = 0.72;
        } else {
          cr = UNPLAYED_R; cg = UNPLAYED_G; cb = UNPLAYED_B;
          brightAlpha = 0.25; dimAlpha = 0.15;
        }
      }

      const brightA255 = ((brightAlpha * fade) * 255 + 0.5) | 0;
      const dimA255    = ((dimAlpha    * fade) * 255 + 0.5) | 0;
      const alphaDiff  = dimA255 - brightA255;
      const topHInv    = 1 / Math.max(1, topH);
      const botHInv    = 1 / Math.max(1, botH);

      // Top half: bright at centre, dim at tip.
      const topStart = Math.max(0, Math.round(cyPx - topH));
      if (buf32) {
        for (let y = topStart; y < cyPx; y++) {
          const a = (brightA255 + (alphaDiff * (cyPx - y) * topHInv + 0.5)) | 0;
          buf32[y * pxW + px] = (a << 24) | (cb << 16) | (cg << 8) | cr;
        }
      } else {
        for (let y = topStart; y < cyPx; y++) {
          const a   = (brightA255 + (alphaDiff * (cyPx - y) * topHInv + 0.5)) | 0;
          const off = (y * pxW + px) * 4;
          buf[off] = cr; buf[off + 1] = cg; buf[off + 2] = cb; buf[off + 3] = a;
        }
      }

      // Bottom half: bright at centre, dim at tip.
      const botEnd = Math.min(pxH, Math.round(cyPx + botH));
      if (buf32) {
        for (let y = cyPx; y < botEnd; y++) {
          const a = (brightA255 + (alphaDiff * (y - cyPx) * botHInv + 0.5)) | 0;
          buf32[y * pxW + px] = (a << 24) | (cb << 16) | (cg << 8) | cr;
        }
      } else {
        for (let y = cyPx; y < botEnd; y++) {
          const a   = (brightA255 + (alphaDiff * (y - cyPx) * botHInv + 0.5)) | 0;
          const off = (y * pxW + px) * 4;
          buf[off] = cr; buf[off + 1] = cg; buf[off + 2] = cb; buf[off + 3] = a;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // ── Overlay (beat grid, labels, playhead) — use CSS coords via scale ─
    ctx.save();
    ctx.scale(dpr, dpr);

    // ── Beat / bar grid (batched into two paths for minimal draw calls) ───
    const downbeatSet = new Set(bd.downbeats);

    ctx.beginPath();
    ctx.strokeStyle = BEAT_LINE_COLOR;
    ctx.lineWidth   = 1;
    for (const beatTime of bd.beats) {
      if (downbeatSet.has(beatTime)) continue;
      const x = ((beatTime - leftTime) / winSec) * cssW;
      if (x < -1 || x > cssW + 1) continue;
      ctx.moveTo(x, TOP_MARGIN + 2);
      ctx.lineTo(x, CSS_H);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = BAR_LINE_COLOR;
    ctx.lineWidth   = 1;
    for (const beatTime of bd.downbeats) {
      const x = ((beatTime - leftTime) / winSec) * cssW;
      if (x < -1 || x > cssW + 1) continue;
      ctx.moveTo(x, TOP_MARGIN);
      ctx.lineTo(x, CSS_H);
    }
    ctx.stroke();

    // Downbeat triangles (batched into one fill path).
    ctx.fillStyle = '#e05d38';
    ctx.beginPath();
    for (const beatTime of bd.downbeats) {
      const x = ((beatTime - leftTime) / winSec) * cssW;
      if (x < -TRI_W || x > cssW + TRI_W) continue;
      ctx.moveTo(x - TRI_W, 0);
      ctx.lineTo(x + TRI_W, 0);
      ctx.lineTo(x, TRI_H);
      ctx.closePath();
    }
    ctx.fill();

    // ── Bar-number labels ─────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font      = 'bold 9px monospace';
    ctx.textAlign = 'left';

    let barIdx = 0;
    for (const dbTime of bd.downbeats) {
      barIdx++;
      const x = ((dbTime - leftTime) / winSec) * cssW;
      if (x < 0 || x > cssW - 4) continue;
      ctx.fillText(String(barIdx), x + 2, TRI_H + 8);
    }

    // ── Centre playhead ───────────────────────────────────────────────────
    ctx.fillStyle = PLAYHEAD_COLOR;
    ctx.fillRect(cssW / 2 - 0.75, 0, 1.5, CSS_H);

    // ── Hover line ────────────────────────────────────────────────────────
    const hov = hoverXRef.current;
    if (hov !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(hov * cssW - 0.5, 0, 1, CSS_H);
    }

    ctx.restore();
  }, [audioRef]);  // audioRef is a stable ref object

  // ── rAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let lastTime = 0;
    const loop = (now: number) => {
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
      lastTime = now;

      // Advance fade-in (0→1 over 200ms) whenever audioBuffer data is available.
      if (monoRef.current) {
        if (fadeRef.current < 1) {
          fadeRef.current = Math.min(1, fadeRef.current + dt / 0.2);
          dirtyRef.current = true;
        }
      } else {
        if (fadeRef.current !== 0) { fadeRef.current = 0; dirtyRef.current = true; }
      }

      // Smooth zoom: exponential ease toward target bars (~100ms feel).
      const targetBars = barsRef.current;
      if (animBarsRef.current !== targetBars) {
        const k = 1 - Math.exp(-dt / 0.03);
        animBarsRef.current += (targetBars - animBarsRef.current) * k;
        if (Math.abs(animBarsRef.current - targetBars) < 0.001) {
          animBarsRef.current = targetBars;
        }
        dirtyRef.current = true;
      }

      // Draw only when something changed or audio is playing.
      const isPlaying = !!(audioRef.current && !audioRef.current.paused);
      if (dirtyRef.current || isPlaying) {
        draw();
        dirtyRef.current = false;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw, audioRef]);

  // ── ResizeObserver ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const cssW = entries[0].contentRect.width;
      sizeRef.current = { width: cssW };

      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const pxW = Math.round(cssW * dpr);
        const pxH = Math.round(CSS_H * dpr);
        if (canvas.width !== pxW || canvas.height !== pxH) {
          canvas.width  = pxW;
          canvas.height = pxH;
        }
        physRef.current = { pxW, pxH };
      }

      // Redraw synchronously so the canvas is never left blank after a resize.
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // ── Interaction ───────────────────────────────────────────────────────────
  const timeAtX = useCallback((clientX: number, rect: DOMRect): number => {
    const frac    = (clientX - rect.left) / rect.width;
    const curr    = audioRef.current?.currentTime ?? 0;
    const winSec  = barsRef.current * 4 * (60 / beatDataRef.current.bpm);
    const t       = curr - winSec / 2 + frac * winSec;
    return Math.max(0, Math.min(durationRef.current, t));
  }, [audioRef]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const audio = audioRef.current;
    wasPlayingRef.current = !!audio && !audio.paused;
    if (audio && !audio.paused) audio.pause();
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startTime: audio?.currentTime ?? 0,
      moved: false,
    };
    // Toggle cursor directly on DOM — avoids a React re-render.
    containerRef.current?.classList.remove('cursor-grab');
    containerRef.current?.classList.add('cursor-grabbing');
    dirtyRef.current = true;
  }, [audioRef]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = e.currentTarget.getBoundingClientRect();

    if (drag.active) {
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 3) drag.moved = true;
      const winSec  = barsRef.current * 4 * (60 / beatDataRef.current.bpm);
      const cssW    = sizeRef.current.width;
      const newTime = drag.startTime - (dx / cssW) * winSec;
      onSeek(Math.max(0, Math.min(durationRef.current, newTime)));
    }

    const t   = timeAtX(e.clientX, rect);
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    hoverXRef.current = pct / 100;

    // Update tooltip directly — no React state, no re-render on every move.
    const el = tooltipRef.current;
    if (el) {
      el.textContent   = fmtTime(t);
      el.style.left    = `clamp(16px, ${pct}%, calc(100% - 16px))`;
      el.style.display = '';
    }
    dirtyRef.current = true;
  }, [audioRef, onSeek, timeAtX]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    // Click (no meaningful movement) → seek to that position.
    if (!drag.moved) {
      onSeek(timeAtX(e.clientX, e.currentTarget.getBoundingClientRect()));
    }
    drag.active = false;
    containerRef.current?.classList.remove('cursor-grabbing');
    containerRef.current?.classList.add('cursor-grab');
    dirtyRef.current = true;
    if (wasPlayingRef.current && audioRef.current) {
      audioRef.current.play();
    }
  }, [audioRef, onSeek, timeAtX]);

  const handlePointerLeave = useCallback(() => {
    if (!dragRef.current.active) {
      hoverXRef.current = null;
      const el = tooltipRef.current;
      if (el) el.style.display = 'none';
      dirtyRef.current = true;
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full bg-black/90 rounded-sm overflow-hidden select-none cursor-grab"
      style={{ height: CSS_H }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} className="block w-full h-full" style={{ willChange: 'contents' }} />

      {/* Zoom control */}
      {onBarsChange && (() => {
        const idx = ZOOM_LEVELS.findIndex(z => z.bars === bars);
        const safeIdx = idx === -1 ? 1 : idx;
        const canOut = safeIdx > 0;
        const canIn  = safeIdx < ZOOM_LEVELS.length - 1;
        const stopAll = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
        return (
          <div
            className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 z-10 bg-black/50 backdrop-blur-sm rounded px-1.5 py-0.5"
            onPointerDown={stopAll}
          >
            <button
              onClick={(e) => { e.stopPropagation(); if (canOut) onBarsChange(ZOOM_LEVELS[safeIdx - 1].bars); }}
              disabled={!canOut}
              className="flex items-center justify-center w-4 h-4 rounded transition-colors text-white/50 hover:text-white/90 hover:bg-white/15 disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
            ><ZoomOut size={11} /></button>
            <span className="text-[8px] font-mono text-white/70 px-1 min-w-11.5 text-center">
              {ZOOM_LEVELS[safeIdx]?.label ?? `${bars} bars`}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); if (canIn) onBarsChange(ZOOM_LEVELS[safeIdx + 1].bars); }}
              disabled={!canIn}
              className="flex items-center justify-center w-4 h-4 rounded transition-colors text-white/50 hover:text-white/90 hover:bg-white/15 disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
            ><ZoomIn size={11} /></button>
          </div>
        );
      })()}

      {/* BPM badge */}
      <div className="absolute top-1 left-1.5 text-[8px] font-mono text-white/35 pointer-events-none select-none">
        {beatData.bpm.toFixed(1)} BPM
      </div>

      {/* Hover time tooltip — always in the DOM, shown/hidden via ref. */}
      <div
        ref={tooltipRef}
        className="absolute bottom-1 pointer-events-none text-[9px] font-mono text-white/90 bg-black/60 px-1 py-0.5 rounded whitespace-nowrap -translate-x-1/2"
        style={{ display: 'none' }}
      />
    </div>
  );
}
