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

/** Highest summed alpha anywhere on the strip, where overlapping bands
 *  stack. Exposed so tests can check tints never bury the waveform. */
function maxCoverage(bands: StripBand[]): number {
  let max = 0;
  for (const b of bands) {
    const at = bands
      .filter((o) => o.startS <= b.startS && o.endS > b.startS)
      .reduce((sum, o) => sum + o.alpha, 0);
    max = Math.max(max, at);
  }
  return Math.round(max * 1000) / 1000;
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
      colours.current.clear();
    });
    // ``getComputedStyle`` per frame forces a style recalc; resolve once.
    const colours = useRef(new Map<string, string>());
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
      const colour = (token: string) => {
        let c = colours.current.get(token);
        if (c === undefined) {
          c = getComputedStyle(canvas).getPropertyValue(token).trim() || "#888";
          colours.current.set(token, c);
        }
        return c;
      };
      for (const band of p.bands) {
        const x0 = Math.max(0, xOf(band.startS));
        const x1 = Math.min(w, xOf(band.endS));
        if (x1 <= x0) continue;
        ctx.globalAlpha = band.alpha;
        ctx.fillStyle = colour(band.token);
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour("--color-text-subtle");

      // Bars sit on a grid fixed in strip time, so scrolling slides them
      // instead of re-binning (which made them flicker). Each takes the
      // loudest peak it covers so zoomed-out views keep their transients.
      const step = BAR_PX + GAP_PX;
      const mid = h / 2;
      const barS = step / p.pxPerS;
      const first = Math.floor(leftS / barS);
      const last = Math.ceil((leftS + w / p.pxPerS) / barS);
      for (let k = first; k <= last; k++) {
        const from = (k * barS - p.startS) * p.peaksPerS;
        const i0 = Math.max(0, Math.floor(from));
        const i1 = Math.min(
          p.peaks.length,
          Math.max(i0 + 1, Math.ceil(from + barS * p.peaksPerS)),
        );
        let v = 0;
        for (let i = i0; i < i1; i++) v = Math.max(v, p.peaks[i] ?? 0);
        if (v <= 0) continue;
        const bh = Math.max(1, v * (h - 4));
        ctx.fillRect(xOf(k * barS), mid - bh / 2, BAR_PX, bh);
      }
      for (const marker of p.markers) {
        const x = xOf(marker.atS);
        if (x < 0 || x > w) continue;
        ctx.fillStyle = colour(marker.token);
        ctx.fillRect(Math.round(x) - 1, 0, 2, h);
      }
      // Observable state for tests: the canvas content itself isn't.
      canvas.dataset.centerS = t.toFixed(2);
      canvas.dataset.pxPerS = String(p.pxPerS);
      canvas.dataset.bands = String(p.bands.length);
      canvas.dataset.maxTint = String(maxCoverage(p.bands));
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
