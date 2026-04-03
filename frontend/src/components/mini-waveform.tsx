'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { usePlayer, type PlayerTrack } from '@/lib/player-context';

interface MiniWaveformProps {
  track: PlayerTrack;
  className?: string;
  /** Set to true once artwork has loaded/errored — delays peak fetch until then */
  artworkReady?: boolean;
}

const BAR_COUNT = 60;
const BAR_GAP = 1;

export function MiniWaveform({ track, className, artworkReady = true }: MiniWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<number[] | null>(null);
  const [peaksLoaded, setPeaksLoaded] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const fetchedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const { currentTrack, subscribeProgress, seek, toggle, duration } = usePlayer();
  const isActive = currentTrack?.filePath === track.filePath;
  // Keep isActive in a ref so the draw callback sees the latest value without re-subscriptions
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const currentProgressRef = useRef(0);
  const hoverXRef = useRef<number | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const draw = useCallback((progress: number, hoverX: number | null = null) => {
    const canvas = canvasRef.current;
    if (!canvas || !peaksRef.current) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const barW = (w - (BAR_COUNT - 1) * BAR_GAP) / BAR_COUNT;
    const played = Math.round(progress * BAR_COUNT);
    const active = isActiveRef.current;
    const isDark = document.documentElement.classList.contains('dark');

    for (let i = 0; i < BAR_COUNT; i++) {
      const amp = peaksRef.current[i] ?? 0.3;
      const barH = Math.max(2, amp * h * 0.9);
      const x = i * (barW + BAR_GAP);
      const y = (h - barH) / 2;

      if (active && i < played) {
        /* Primary colors (defined in globals.css: --primary-light, --primary-dark) */
        ctx.fillStyle = isDark ? 'rgb(208 253 90 / 0.9)' : 'rgb(189 231 82 / 0.9)';
      } else if (active) {
        ctx.fillStyle = isDark ? 'rgb(208 253 90 / 0.35)' : 'rgb(189 231 82 / 0.35)';
      } else {
        ctx.fillStyle = 'rgb(128 128 128 / 0.4)';
      }

      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(1, barW), barH, 1);
      ctx.fill();
    }

    // Hover cursor
    if (hoverX !== null) {
      ctx.save();
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hoverX, 0);
      ctx.lineTo(hoverX, h);
      ctx.stroke();

      const dur = durationRef.current;
      if (dur > 0) {
        const t = (hoverX / w) * dur;
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        const label = `${m}:${s.toString().padStart(2, '0')}`;
        ctx.font = '9px monospace';
        ctx.textBaseline = 'top';
        const pad = 2;
        const tw = ctx.measureText(label).width;
        let lx = hoverX + 3;
        if (lx + tw + pad * 2 > w) lx = hoverX - tw - pad * 2 - 3;
        ctx.fillStyle = isDark ? 'rgba(12,16,25,0.82)' : 'rgba(255,255,255,0.82)';
        ctx.fillRect(lx - pad, 0, tw + pad * 2, 11);
        ctx.fillStyle = isDark ? 'rgba(184,188,198,0.95)' : 'rgba(51,51,51,0.9)';
        ctx.fillText(label, lx, 1);
      }

      ctx.restore();
    }
  }, []);

  const fetchPeaks = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    abortRef.current = new AbortController();
    try {
      const data = await api.getFilePeaks(track.filePath, BAR_COUNT, abortRef.current.signal);
      peaksRef.current = data;
      setPeaksLoaded(true);
      draw(0);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      peaksRef.current = Array(BAR_COUNT).fill(0.3);
      setPeaksLoaded(true);
      draw(0);
    }
  }, [track.filePath, draw]);

  // Load peaks once visible AND artwork has settled
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !artworkReady) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchPeaks();
          observerRef.current?.disconnect();
        }
      }
    );
    observerRef.current.observe(el);

    return () => {
      observerRef.current?.disconnect();
      abortRef.current?.abort(new DOMException('Request cancelled', 'AbortError'));
      fetchedRef.current = false;
    };
  }, [fetchPeaks, artworkReady]);

  // Subscribe to live progress updates when this track is active; redraw on isActive/peaks change
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
  }, [isActive, peaksLoaded, subscribeProgress, draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    hoverXRef.current = e.clientX - rect.left;
    draw(currentProgressRef.current, hoverXRef.current);
  }, [draw]);

  const handleMouseLeave = useCallback(() => {
    hoverXRef.current = null;
    draw(currentProgressRef.current, null);
  }, [draw]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (isActive) {
      const rect = e.currentTarget.getBoundingClientRect();
      seek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    } else {
      toggle(track);
    }
  }, [isActive, seek, toggle, track]);

  return (
    <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }}>
      {peaksLoaded ? (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Waveform for ${track.title || track.fileName}`}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ width: '100%', height: '100%', display: 'block', cursor: 'pointer' }}
        />
      ) : (
        // Placeholder skeleton bars while loading
        <div className="flex items-center gap-px h-full w-full" onClick={(e) => { e.stopPropagation(); toggle(track); }} style={{ cursor: 'pointer' }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-muted animate-pulse"
              style={{ height: `${20 + Math.random() * 60}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
