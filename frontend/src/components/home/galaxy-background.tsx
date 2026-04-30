"use client";

import { useEffect, useRef } from "react";

type Star = {
  x: number;
  y: number;
  r: number;
  baseAlpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  depth: number; // 0..1, smaller = farther
  hue: number; // 0 = white, 1 = brand-tinted
};

type Shooting = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
};

const STAR_COUNT = 260;

function readBrandHue(): number {
  if (typeof window === "undefined") return 260;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent-hue")
    .trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 260;
}

function readBrandChroma(): number {
  if (typeof window === "undefined") return 0.15;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent-chroma")
    .trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0.15;
}

function readIsDark(): boolean {
  if (typeof window === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

export function GalaxyBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mouse = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let stars: Star[] = [];
    const shooting: Shooting[] = [];
    let raf = 0;
    let lastTime = performance.now();
    let nextShootAt = performance.now() + 2500 + Math.random() * 3000;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Star positions are stored in normalized [0, 1] coords so window resizes
    // re-scale rather than reshuffle them.
    const seed = () => {
      stars = new Array(STAR_COUNT).fill(0).map(() => {
        const depth = Math.pow(Math.random(), 1.6); // bias toward far
        return {
          x: Math.random(),
          y: Math.random(),
          r: 0.3 + depth * 1.6,
          baseAlpha: 0.25 + depth * 0.7,
          twinkleSpeed: 0.4 + Math.random() * 1.4,
          twinklePhase: Math.random() * Math.PI * 2,
          depth,
          hue: Math.random() < 0.25 ? 1 : 0,
        };
      });
    };

    const spawnShooting = () => {
      // Top-left area, flying to bottom-right
      const fromLeft = Math.random() < 0.7;
      const x = fromLeft
        ? Math.random() * width * 0.4
        : width * (0.6 + Math.random() * 0.4);
      const y = Math.random() * height * 0.5;
      const angle = fromLeft
        ? Math.PI / 6 + Math.random() * 0.3 // down-right
        : Math.PI - Math.PI / 6 - Math.random() * 0.3; // down-left
      const speed = 700 + Math.random() * 400;
      shooting.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.5,
      });
    };

    let hue = readBrandHue();
    let chroma = readBrandChroma();
    let isDark = readIsDark();

    const themeObserver = new MutationObserver(() => {
      hue = readBrandHue();
      chroma = readBrandChroma();
      isDark = readIsDark();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      // Ease mouse
      mouse.current.x += (mouse.current.tx - mouse.current.x) * 0.05;
      mouse.current.y += (mouse.current.ty - mouse.current.y) * 0.05;

      ctx.clearRect(0, 0, width, height);

      // Subtle nebula wash
      const nebula = ctx.createRadialGradient(
        width * 0.25,
        height * 0.7,
        0,
        width * 0.25,
        height * 0.7,
        Math.max(width, height) * 0.7,
      );
      nebula.addColorStop(0, `oklch(0.55 ${chroma * 0.5} ${hue} / 0.05)`);
      nebula.addColorStop(1, `oklch(0.55 ${chroma * 0.5} ${hue} / 0)`);
      ctx.fillStyle = nebula;
      ctx.fillRect(0, 0, width, height);

      // Stars
      const mx = (mouse.current.x - 0.5) * 40;
      const my = (mouse.current.y - 0.5) * 40;
      for (const s of stars) {
        s.twinklePhase += dt * s.twinkleSpeed;
        const tw = 0.55 + 0.45 * Math.sin(s.twinklePhase);
        const alpha = s.baseAlpha * tw;
        const px = s.x * width + mx * s.depth;
        const py = s.y * height + my * s.depth;

        // Glow for brand-tinted / larger stars
        if (s.hue === 1 || s.r > 1.3) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, s.r * 6);
          const col =
            s.hue === 1
              ? `oklch(0.85 ${chroma} ${hue} / ${alpha * 0.5})`
              : `oklch(0.98 0 0 / ${alpha * 0.35})`;
          g.addColorStop(0, col);
          g.addColorStop(
            1,
            s.hue === 1
              ? `oklch(0.85 ${chroma} ${hue} / 0)`
              : `oklch(0.98 0 0 / 0)`,
          );
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(px, py, s.r * 6, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle =
          s.hue === 1
            ? `oklch(0.9 ${chroma} ${hue} / ${alpha})`
            : `oklch(${isDark ? 0.98 : 0.35} 0 0 / ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Shooting stars
      if (now >= nextShootAt) {
        spawnShooting();
        nextShootAt = now + 3500 + Math.random() * 4500;
      }
      for (let i = shooting.length - 1; i >= 0; i--) {
        const sh = shooting[i];
        sh.life += dt;
        const progress = sh.life / sh.maxLife;
        if (progress >= 1) {
          shooting.splice(i, 1);
          continue;
        }
        const prevX = sh.x;
        const prevY = sh.y;
        sh.x += sh.vx * dt;
        sh.y += sh.vy * dt;
        const tailLen = 120;
        const dx = sh.vx;
        const dy = sh.vy;
        const mag = Math.hypot(dx, dy) || 1;
        const tx = sh.x - (dx / mag) * tailLen;
        const ty = sh.y - (dy / mag) * tailLen;
        const fade =
          progress < 0.15
            ? progress / 0.15
            : progress > 0.7
              ? 1 - (progress - 0.7) / 0.3
              : 1;
        const grad = ctx.createLinearGradient(sh.x, sh.y, tx, ty);
        grad.addColorStop(0, `oklch(0.95 ${chroma} ${hue} / ${0.9 * fade})`);
        grad.addColorStop(1, `oklch(0.95 ${chroma} ${hue} / 0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();

        // Head
        ctx.fillStyle = `oklch(0.98 ${chroma * 0.5} ${hue} / ${fade})`;
        ctx.beginPath();
        ctx.arc(sh.x, sh.y, 2, 0, Math.PI * 2);
        ctx.fill();

        void prevX;
        void prevY;
      }

      raf = requestAnimationFrame(render);
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.current.tx = (e.clientX - rect.left) / rect.width;
      mouse.current.ty = (e.clientY - rect.top) / rect.height;
    };

    seed();
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
