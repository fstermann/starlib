"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadWaveform,
  type WaveformVariant,
} from "@/components/rekordbox-waveform";
import { usePlayer } from "@/lib/player-context";
import { cn } from "@/lib/utils";

interface PlayerRekordboxWaveformProps {
  trackId: string;
  device?: string;
  /** `"color"` renders the PWV4 RGB preview; `"blue"` the PWAV monochrome one. */
  variant: WaveformVariant;
  /** Track length in seconds, for the hover time label. */
  durationSec: number;
  className?: string;
}

const COLOR_COLS = 1200; // PWV4 columns (6 bytes each)
const BLUE_COLS = 400; // PWAV columns (1 byte each)

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Full-width Rekordbox waveform for the bottom player, drawn from Rekordbox's
 * own PWV4 (RGB) or PWAV (blue) analysis. Layered over the WaveSurfer container
 * (which stays mounted, invisible, to keep driving audio) and owns its own
 * click-to-seek, played overlay, and hover cursor + time label.
 */
export function PlayerRekordboxWaveform({
  trackId,
  device,
  variant,
  durationSec,
  className,
}: PlayerRekordboxWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Uint8Array | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const { subscribeProgress, seek } = usePlayer();
  const progressRef = useRef(0);
  const hoverXRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadWaveform(trackId, device, variant).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [trackId, device, variant]);

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
    (progress: number, hoverX: number | null) => {
      const canvas = canvasRef.current;
      const { w: cssW, h: cssH } = size;
      if (!canvas || cssW === 0 || cssH === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const mid = cssH / 2;
      const halfH = cssH / 2;
      const cols = variant === "color" ? COLOR_COLS : BLUE_COLS;
      const stride = variant === "color" ? 6 : 1;

      if (data && data.length >= cols * stride) {
        const step = cols / cssW;
        for (let x = 0; x < cssW; x++) {
          const start = Math.floor(x * step);
          const end = Math.max(start + 1, Math.floor((x + 1) * step));
          let r = 0,
            g = 0,
            b = 0,
            h = 0,
            n = 0;
          for (let i = start; i < end && i < cols; i++) {
            const o = i * stride;
            if (variant === "color") {
              const d3 = data[o + 3] & 0x7f;
              const d4 = data[o + 4] & 0x7f;
              const d5 = data[o + 5] & 0x7f;
              r += (d3 / 127) * 255;
              g += (d4 / 127) * 255;
              b += (d5 / 127) * 255;
              h += Math.max(d3, d4, d5) / 127;
            } else {
              const height = (data[o] & 0x1f) / 31;
              const white = ((data[o] >> 5) & 0x07) / 7;
              // Rekordbox blue: dim blue silhouette brightening toward cyan-white
              // where the whiteness bits are set.
              r += 40 + white * 150;
              g += 120 + white * 110;
              b += 220 + white * 35;
              h += height;
            }
            n++;
          }
          if (n === 0) continue;
          const norm = h / n; // 0..1
          const barH = Math.max(1, Math.round(norm * halfH));
          ctx.fillStyle = `rgb(${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0})`;
          ctx.fillRect(x, mid - barH, 1, barH * 2);
        }
      }

      // Played overlay up to the current position.
      if (progress > 0) {
        const playedX = Math.round(progress * cssW);
        ctx.save();
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillRect(0, 0, playedX, cssH);
        ctx.restore();
      }

      // Hover cursor + time label.
      if (hoverX !== null) {
        const isDark = document.documentElement.classList.contains("dark");
        ctx.save();
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hoverX + 0.5, 0);
        ctx.lineTo(hoverX + 0.5, cssH);
        ctx.stroke();
        const label = formatTime((hoverX / cssW) * durationSec);
        ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(label).width + 6;
        const preferLeft = hoverX > cssW - tw - 2;
        const bx = preferLeft ? hoverX - tw - 2 : hoverX + 2;
        ctx.fillStyle = isDark
          ? "rgba(12,16,25,0.82)"
          : "rgba(255,255,255,0.82)";
        ctx.fillRect(bx, 1, tw, 12);
        ctx.fillStyle = isDark
          ? "rgba(184,188,198,0.95)"
          : "rgba(51,51,51,0.9)";
        ctx.textBaseline = "top";
        ctx.fillText(label, bx + 3, 2);
        ctx.restore();
      }
    },
    [data, size, variant, durationSec],
  );

  // Redraw on data/size/variant change and subscribe to live progress.
  useEffect(() => {
    draw(progressRef.current, hoverXRef.current);
    return subscribeProgress((p) => {
      progressRef.current = p;
      draw(p, hoverXRef.current);
    });
  }, [draw, subscribeProgress]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      hoverXRef.current = e.clientX - rect.left;
      draw(progressRef.current, hoverXRef.current);
    },
    [draw],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverXRef.current === null) return;
    hoverXRef.current = null;
    draw(progressRef.current, null);
  }, [draw]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      seek(frac);
    },
    [seek],
  );

  return (
    <div ref={wrapRef} className={cn("size-full", className)}>
      <canvas
        ref={canvasRef}
        className="block size-full cursor-pointer"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        aria-hidden
      />
    </div>
  );
}
