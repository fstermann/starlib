"use client";

import { useEffect, useRef } from "react";

type Star = {
  // Position in normalized 3D space; z runs from FAR → 0 toward the viewer.
  x: number;
  y: number;
  z: number;
  // 1 → brand-tinted; 0 → neutral white. Matches GalaxyBackground's mix.
  brand: 0 | 1;
};

const STAR_COUNT = 320;
const FAR = 1;
const SPEED = 0.026;

function readNum(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Star Wars-style hyperspace travel. Stars stream radially outward from the
 * center with motion-trails. On `phase === "exit"` it decelerates to a static
 * field whose color/density matches GalaxyBackground, so the host can
 * crossfade seamlessly into the home screen.
 */
export function HyperspaceLoader({
  phase,
  className = "",
}: {
  phase: "travel" | "exit";
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const stars: Star[] = Array.from({ length: STAR_COUNT }, () => ({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: Math.random() * FAR,
      brand: Math.random() < 0.35 ? 1 : 0,
    }));

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let hue = readNum("--accent-hue", 260);
    let chroma = readNum("--accent-chroma", 0.15);
    const themeObserver = new MutationObserver(() => {
      hue = readNum("--accent-hue", 260);
      chroma = readNum("--accent-chroma", 0.15);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    let raf = 0;
    let speedMul = reduce ? 0 : 1;

    function frame() {
      if (!ctx) return;
      const cx = width / 2;
      const cy = height / 2;
      const focal = Math.min(width, height) * 0.9;

      const exiting = phaseRef.current === "exit";
      if (exiting) {
        speedMul += (0 - speedMul) * 0.12;
      } else {
        speedMul += (1 - speedMul) * 0.04;
      }

      // Motion-blur trail: heavier fade during exit so streaks shorten into
      // dots that match GalaxyBackground before the loader crossfades out.
      const fade = exiting ? 0.55 : 0.28;
      ctx.fillStyle = `oklch(0 0 0 / ${fade})`;
      ctx.fillRect(0, 0, width, height);

      for (const s of stars) {
        const prevZ = s.z;
        s.z -= SPEED * speedMul;
        if (s.z <= 0.001) {
          s.x = (Math.random() - 0.5) * 2;
          s.y = (Math.random() - 0.5) * 2;
          s.z = FAR;
          continue;
        }

        const sx = (s.x / s.z) * focal + cx;
        const sy = (s.y / s.z) * focal + cy;
        const psx = (s.x / prevZ) * focal + cx;
        const psy = (s.y / prevZ) * focal + cy;

        if (sx < -50 || sx > width + 50 || sy < -50 || sy > height + 50)
          continue;

        const closeness = 1 - s.z;
        const radius = Math.max(0.5, closeness * 2.2);
        const a = Math.min(1, closeness * 1.2);

        const trailColor =
          s.brand === 1
            ? `oklch(0.85 ${chroma} ${hue} / ${a * 0.5})`
            : `oklch(0.98 0 0 / ${a * 0.45})`;
        const headColor =
          s.brand === 1
            ? `oklch(0.92 ${chroma} ${hue} / ${a})`
            : `oklch(0.98 0 0 / ${a})`;

        // Trail (skipped if essentially stationary — looks like static dots).
        if (speedMul > 0.05) {
          ctx.strokeStyle = trailColor;
          ctx.lineWidth = radius;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(psx, psy);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }

        // Glow for brand-tinted / larger heads (mirrors GalaxyBackground).
        if (s.brand === 1 || radius > 1.4) {
          const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius * 6);
          g.addColorStop(
            0,
            s.brand === 1
              ? `oklch(0.85 ${chroma} ${hue} / ${a * 0.5})`
              : `oklch(0.98 0 0 / ${a * 0.35})`,
          );
          g.addColorStop(
            1,
            s.brand === 1
              ? `oklch(0.85 ${chroma} ${hue} / 0)`
              : `oklch(0.98 0 0 / 0)`,
          );
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sx, sy, radius * 6, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = headColor;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="hyperspace-canvas"
      aria-hidden="true"
      className={`block h-full w-full ${className}`}
    />
  );
}
