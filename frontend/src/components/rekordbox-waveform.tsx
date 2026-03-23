'use client';

import { useRef, useEffect, useCallback } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { RekordboxEntry, RekordboxBeat } from '@/hooks/use-rekordbox-waveform';

interface RekordboxWaveformProps {
  entries: RekordboxEntry[];
  beats: RekordboxBeat[];
  duration: number;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  audioBuffer: AudioBuffer | null;
  onSeek: (time: number) => void;
  bars?: number;
  onBarsChange?: (bars: number) => void;
}

// ── Zoom levels ─────────────────────────────────────────────────────────────
const ZOOM_LEVELS: Array<{ bars: number; label: string }> = [
  { bars: 16,   label: '16 bars' },
  { bars: 8,    label: '8 bars'  },
  { bars: 4,    label: '4 bars'  },
  { bars: 2,    label: '2 bars'  },
  { bars: 1,    label: '1 bar'   },
  { bars: 0.5,  label: '2 beats' },
  { bars: 0.25, label: '1 beat'  },
];

// ── Visual constants ────────────────────────────────────────────────────────
const CSS_H            = 96;
const TOP_MARGIN       = 14;
const TRI_H            = 6;
const TRI_W            = 3;
const BEAT_LINE_COLOR  = 'rgba(255,255,255,0.15)';
const BAR_LINE_COLOR   = 'rgba(255,255,255,0.30)';
const PLAYHEAD_COLOR   = 'rgba(255,255,255,0.95)';

// 150 PWV5 entries per second of audio.
const ENTRIES_PER_SEC  = 150;
/** Decimation rate for the low-pass waveform contour (samples/sec). */
const DECIMATE_RATE    = 600;

const IS_LITTLE_ENDIAN = new Uint32Array(new Uint8Array([1, 0, 0, 0]).buffer)[0] === 1;

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function RekordboxWaveform({
  entries,
  beats,
  duration,
  audioRef,
  audioBuffer,
  onSeek,
  bars = 16,
  onBarsChange,
}: RekordboxWaveformProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const tooltipRef    = useRef<HTMLDivElement>(null);
  const rafRef        = useRef<number>(0);
  const sizeRef       = useRef({ width: 0 });
  const physRef       = useRef({ pxW: 0, pxH: 0 });
  const imgRef        = useRef<ImageData | null>(null);
  const dirtyRef      = useRef(true);
  const hoverXRef     = useRef<number | null>(null);
  const animBarsRef   = useRef(bars);
  const dragRef       = useRef<{ active: boolean; startX: number; startTime: number; moved: boolean }>({
    active: false, startX: 0, startTime: 0, moved: false,
  });
  const wasPlayingRef = useRef(false);

  // Mutable prop refs.
  const entriesRef  = useRef(entries);
  const beatsRef    = useRef(beats);
  const durationRef = useRef(duration);
  const barsRef     = useRef(bars);

  if (entriesRef.current  !== entries)  { entriesRef.current  = entries;  dirtyRef.current = true; }
  if (beatsRef.current    !== beats)    { beatsRef.current    = beats;    dirtyRef.current = true; }
  if (durationRef.current !== duration) { durationRef.current = duration; dirtyRef.current = true; }
  if (barsRef.current     !== bars)     { barsRef.current     = bars;     dirtyRef.current = true; }

  // Cached mono channel data — computed once per audioBuffer change.
  const monoRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null);
  // Low-pass decimated mono for smooth waveform contour rendering.
  const decimatedRef = useRef<{ samples: Float32Array; rate: number } | null>(null);
  const audioBufferRef = useRef(audioBuffer);
  if (audioBufferRef.current !== audioBuffer) {
    audioBufferRef.current = audioBuffer;
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

  // Derive BPM from beat grid.  Fall back to 120 if no beats.
  const bpmRef = useRef(120);
  useEffect(() => {
    if (beats.length > 0) {
      // Use tempo from the first beat (BPM value).
      bpmRef.current = beats[0].tempo;
    }
  }, [beats]);

  // Pre-compute downbeat times array for fast lookup in draw.
  const downbeatsRef = useRef<number[]>([]);
  const beatTimesRef = useRef<number[]>([]);
  useEffect(() => {
    const db: number[] = [];
    const bt: number[] = [];
    for (const b of beats) {
      bt.push(b.time);
      if (b.beat === 1) db.push(b.time);
    }
    downbeatsRef.current = db;
    beatTimesRef.current = bt;
    dirtyRef.current = true;
  }, [beats]);

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = sizeRef.current.width;
    if (cssW === 0) return;
    const { pxW, pxH } = physRef.current;
    if (pxW === 0 || pxH === 0) return;

    const dpr     = window.devicePixelRatio || 1;
    const ents    = entriesRef.current;
    const dur     = durationRef.current;
    const curr    = audioRef.current?.currentTime ?? 0;
    const numBars = animBarsRef.current;
    const bpm     = bpmRef.current;
    const nEntries = ents.length;
    const mono    = monoRef.current;

    if (nEntries === 0 || dur <= 0) {
      ctx.clearRect(0, 0, pxW, pxH);
      return;
    }

    // ── Window (centred on current time) ──────────────────────────────────
    const secPerBeat = 60 / bpm;
    const winSec     = numBars * 4 * secPerBeat;
    const leftTime   = curr - winSec / 2;

    // ── Waveform via ImageData ────────────────────────────────────────────
    const cyPx   = Math.round(((CSS_H + TOP_MARGIN) / 2) * dpr);
    const maxHPx = ((CSS_H - TOP_MARGIN) / 2) * 0.95 * dpr;

    let imgData = imgRef.current;
    if (!imgData || imgData.width !== pxW || imgData.height !== pxH) {
      imgData = ctx.createImageData(pxW, pxH);
      imgRef.current = imgData;
    } else {
      new Uint32Array(imgData.data.buffer).fill(0);
    }

    const buf32 = IS_LITTLE_ENDIAN ? new Uint32Array(imgData.data.buffer) : null;
    const buf   = imgData.data;

    // Audio samples for asymmetric rendering.
    const samples  = mono?.samples;
    const sr       = mono?.sampleRate ?? 44100;
    const numSamps = samples?.length ?? 0;

    // Decimated buffer for smooth waveform contour.
    const dec     = decimatedRef.current;
    const dSamps  = dec?.samples;
    const dRate   = dec?.rate ?? 1;
    const dLen    = dSamps?.length ?? 0;

    for (let px = 0; px < pxW; px++) {
      // Time range this pixel column covers.
      const t0 = leftTime + (px / pxW) * winSec;
      const t1 = leftTime + ((px + 1) / pxW) * winSec;
      const timePx = (t0 + t1) / 2;
      if (t1 < 0 || t0 > dur) continue;

      // Get RGB colour from PWV5 entries (interpolated by time).
      const ef  = timePx * ENTRIES_PER_SEC;
      const ei0 = Math.max(0, Math.min(nEntries - 1, Math.floor(ef)));
      const ei1 = Math.min(nEntries - 1, ei0 + 1);
      const t   = ef - ei0;

      const e0 = ents[ei0];
      const e1 = ents[ei1];
      const cr = Math.round(e0.r + (e1.r - e0.r) * t);
      const cg = Math.round(e0.g + (e1.g - e0.g) * t);
      const cb = Math.round(e0.b + (e1.b - e0.b) * t);

      // Compute waveform height — use decimated (low-pass) buffer for smooth
      // contour, fall back to PWV5 envelope or raw min/max.
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
      } else if (samples && numSamps > 0) {
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
      } else {
        const h = e0.height + (e1.height - e0.height) * t;
        const barH = Math.max(0.75 * dpr, h * maxHPx);
        topH = barH;
        botH = barH;
      }

      // Played = left of centre.
      const played = timePx < curr;
      const brightAlpha = played ? 0.95 : 0.40;
      const dimAlpha    = played ? 0.70 : 0.22;
      const brightA255  = (brightAlpha * 255 + 0.5) | 0;
      const dimA255     = (dimAlpha * 255 + 0.5) | 0;
      const alphaDiff   = dimA255 - brightA255;

      const topStart = Math.max(0, Math.round(cyPx - topH));
      const botEnd   = Math.min(pxH, Math.round(cyPx + botH));
      const topHInv  = 1 / Math.max(1, topH);
      const botHInv  = 1 / Math.max(1, botH);

      if (buf32) {
        for (let y = topStart; y < cyPx; y++) {
          const a = (brightA255 + (alphaDiff * (cyPx - y) * topHInv + 0.5)) | 0;
          buf32[y * pxW + px] = (a << 24) | (cb << 16) | (cg << 8) | cr;
        }
        for (let y = cyPx; y < botEnd; y++) {
          const a = (brightA255 + (alphaDiff * (y - cyPx) * botHInv + 0.5)) | 0;
          buf32[y * pxW + px] = (a << 24) | (cb << 16) | (cg << 8) | cr;
        }
      } else {
        for (let y = topStart; y < cyPx; y++) {
          const a   = (brightA255 + (alphaDiff * (cyPx - y) * topHInv + 0.5)) | 0;
          const off = (y * pxW + px) * 4;
          buf[off] = cr; buf[off + 1] = cg; buf[off + 2] = cb; buf[off + 3] = a;
        }
        for (let y = cyPx; y < botEnd; y++) {
          const a   = (brightA255 + (alphaDiff * (y - cyPx) * botHInv + 0.5)) | 0;
          const off = (y * pxW + px) * 4;
          buf[off] = cr; buf[off + 1] = cg; buf[off + 2] = cb; buf[off + 3] = a;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // ── Overlay (beat grid, labels, playhead) — CSS coords via scale ─
    ctx.save();
    ctx.scale(dpr, dpr);

    const downbeats = downbeatsRef.current;
    const beatTimes = beatTimesRef.current;
    const downbeatSet = new Set(downbeats);

    // Beat lines (non-downbeat).
    ctx.beginPath();
    ctx.strokeStyle = BEAT_LINE_COLOR;
    ctx.lineWidth   = 1;
    for (const bt of beatTimes) {
      if (downbeatSet.has(bt)) continue;
      const x = ((bt - leftTime) / winSec) * cssW;
      if (x < -1 || x > cssW + 1) continue;
      ctx.moveTo(x, TOP_MARGIN + 2);
      ctx.lineTo(x, CSS_H);
    }
    ctx.stroke();

    // Bar lines (downbeats).
    ctx.beginPath();
    ctx.strokeStyle = BAR_LINE_COLOR;
    ctx.lineWidth   = 1;
    for (const db of downbeats) {
      const x = ((db - leftTime) / winSec) * cssW;
      if (x < -1 || x > cssW + 1) continue;
      ctx.moveTo(x, TOP_MARGIN);
      ctx.lineTo(x, CSS_H);
    }
    ctx.stroke();

    // Downbeat triangles.
    ctx.fillStyle = '#e05d38';
    ctx.beginPath();
    for (const db of downbeats) {
      const x = ((db - leftTime) / winSec) * cssW;
      if (x < -TRI_W || x > cssW + TRI_W) continue;
      ctx.moveTo(x - TRI_W, 0);
      ctx.lineTo(x + TRI_W, 0);
      ctx.lineTo(x, TRI_H);
      ctx.closePath();
    }
    ctx.fill();

    // Bar-number labels.
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font      = 'bold 9px monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i < downbeats.length; i++) {
      const x = ((downbeats[i] - leftTime) / winSec) * cssW;
      if (x < 0 || x > cssW - 4) continue;
      ctx.fillText(String(i + 1), x + 2, TRI_H + 8);
    }

    // Centre playhead.
    ctx.fillStyle = PLAYHEAD_COLOR;
    ctx.fillRect(cssW / 2 - 0.75, 0, 1.5, CSS_H);

    // Hover line.
    const hov = hoverXRef.current;
    if (hov !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(hov * cssW - 0.5, 0, 1, CSS_H);
    }

    ctx.restore();
  }, [audioRef]);

  // ── rAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let lastTime = 0;
    const loop = (now: number) => {
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
      lastTime = now;

      // Smooth zoom animation.
      const targetBars = barsRef.current;
      if (animBarsRef.current !== targetBars) {
        const k = 1 - Math.exp(-dt / 0.03);
        animBarsRef.current += (targetBars - animBarsRef.current) * k;
        if (Math.abs(animBarsRef.current - targetBars) < 0.001) {
          animBarsRef.current = targetBars;
        }
        dirtyRef.current = true;
      }

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
    const ro = new ResizeObserver((entries) => {
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
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // ── Interaction ───────────────────────────────────────────────────────────
  const timeAtX = useCallback((clientX: number, rect: DOMRect): number => {
    const frac   = (clientX - rect.left) / rect.width;
    const curr   = audioRef.current?.currentTime ?? 0;
    const winSec = barsRef.current * 4 * (60 / bpmRef.current);
    const t      = curr - winSec / 2 + frac * winSec;
    return Math.max(0, Math.min(durationRef.current, t));
  }, [audioRef]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const audio = audioRef.current;
    wasPlayingRef.current = !!audio && !audio.paused;
    if (audio && !audio.paused) audio.pause();
    dragRef.current = { active: true, startX: e.clientX, startTime: audio?.currentTime ?? 0, moved: false };
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
      const winSec  = barsRef.current * 4 * (60 / bpmRef.current);
      const cssW    = sizeRef.current.width;
      const newTime = drag.startTime - (dx / cssW) * winSec;
      onSeek(Math.max(0, Math.min(durationRef.current, newTime)));
    }

    const t   = timeAtX(e.clientX, rect);
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    hoverXRef.current = pct / 100;

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
        const safeIdx = idx === -1 ? 0 : idx;
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
      <div className="absolute top-1 left-1.5 text-[8px] font-mono text-white/30 pointer-events-none select-none uppercase tracking-wider">
        rekordbox · {bpmRef.current.toFixed(1)} BPM
      </div>

      {/* Hover time tooltip */}
      <div
        ref={tooltipRef}
        className="absolute bottom-1 pointer-events-none text-[9px] font-mono text-white/90 bg-black/60 px-1 py-0.5 rounded whitespace-nowrap -translate-x-1/2"
        style={{ display: 'none' }}
      />
    </div>
  );
}
