"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

/** A span of the strip's own time axis to tint, e.g. where the track plays. */
export interface StripBand {
  startS: number;
  endS: number;
  /** CSS colour token, e.g. ``--color-brand``. */
  token: string;
  alpha: number;
}

/** A vertical line at a strip time, e.g. the suggested start. */
export interface StripMarker {
  atS: number;
  token: string;
}

export interface PeakStripHandle {
  /** Centre time ``t`` (strip seconds) under the playhead and redraw. */
  draw: (t: number) => void;
}

interface PeakStripProps {
  /** Peaks in ``[0, 1]``, ``peaksPerS`` per strip second from ``startS``. */
  peaks: number[];
  peaksPerS: number;
  startS: number;
  pxPerS: number;
  bands: StripBand[];
  markers: StripMarker[];
  /** Strip time drawn on first paint and after any prop change. */
  centerS: number;
}

const BAR_PX = 2;
const GAP_PX = 1;

/** Canvas waveform centred on a time, redrawn only for the visible window.
 *  Cheap enough to repaint every animation frame, unlike scrolling a full-
 *  length WaveSurfer render. */
export const PeakStrip = forwardRef<PeakStripHandle, PeakStripProps>(
  function PeakStrip(
    { peaks, peaksPerS, startS, pxPerS, bands, markers, centerS },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const propsRef = useRef({
      peaks,
      peaksPerS,
      startS,
      pxPerS,
      bands,
      markers,
    });
    // Synced after render so the animation-frame ``draw`` sees fresh props.
    useLayoutEffect(() => {
      propsRef.current = { peaks, peaksPerS, startS, pxPerS, bands, markers };
    });
    const centerRef = useRef(centerS);

    const draw = (t: number) => {
      centerRef.current = t;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr))
        canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr))
        canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const p = propsRef.current;
      const leftS = t - w / 2 / p.pxPerS;
      const xOf = (s: number) => (s - leftS) * p.pxPerS;
      const css = getComputedStyle(canvas);
      for (const band of p.bands) {
        const x0 = Math.max(0, xOf(band.startS));
        const x1 = Math.min(w, xOf(band.endS));
        if (x1 <= x0) continue;
        ctx.globalAlpha = band.alpha;
        ctx.fillStyle = css.getPropertyValue(band.token).trim() || "#888";
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle =
        css.getPropertyValue("--color-text-subtle").trim() || "#888";

      // One bar per BAR_PX + GAP_PX pixels, taking the loudest peak it covers
      // so zoomed-out views keep their transients.
      const step = BAR_PX + GAP_PX;
      const mid = h / 2;
      for (let x = 0; x < w; x += step) {
        const from = (leftS + x / p.pxPerS - p.startS) * p.peaksPerS;
        const to = (leftS + (x + step) / p.pxPerS - p.startS) * p.peaksPerS;
        const i0 = Math.max(0, Math.floor(from));
        const i1 = Math.min(p.peaks.length, Math.max(i0 + 1, Math.ceil(to)));
        let v = 0;
        for (let i = i0; i < i1; i++) v = Math.max(v, p.peaks[i] ?? 0);
        if (v <= 0) continue;
        const bh = Math.max(1, v * (h - 4));
        ctx.fillRect(x, mid - bh / 2, BAR_PX, bh);
      }
      for (const marker of p.markers) {
        const x = xOf(marker.atS);
        if (x < 0 || x > w) continue;
        ctx.fillStyle = css.getPropertyValue(marker.token).trim() || "#888";
        ctx.fillRect(Math.round(x) - 1, 0, 2, h);
      }
      // Observable state for tests: the canvas content itself isn't.
      canvas.dataset.centerS = t.toFixed(2);
      canvas.dataset.pxPerS = String(p.pxPerS);
      canvas.dataset.bands = String(p.bands.length);
    };

    useImperativeHandle(ref, () => ({ draw }));

    useEffect(() => {
      draw(centerS);
    });

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const observer = new ResizeObserver(() => draw(centerRef.current));
      observer.observe(canvas);
      return () => observer.disconnect();
    }, []);

    return <canvas ref={canvasRef} className="block h-full w-full" />;
  },
);
