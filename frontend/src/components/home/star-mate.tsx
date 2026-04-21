"use client";

import { useEffect, useRef, useState } from "react";
// @ts-expect-error — zdog ships no types
import * as Zdog from "zdog";

type Expression = "smile" | "happy" | "wink" | "yawn" | "sleepy" | "surprised";

const EXPRESSION_BAG: Expression[] = [
  "smile",
  "smile",
  "smile",
  "happy",
  "happy",
  "wink",
  "yawn",
  "sleepy",
  "surprised",
];

type Props = {
  size: number;
  className?: string;
  style?: React.CSSProperties;
  seed?: number;
  drift?: 1 | 2 | 3;
  driftDuration?: number;
  driftDelay?: number;
  spin?: number;
};

// Starlib-style chunky rounded star. The thick stroke rounds the corners and
// extrudes the shape into real 3D depth.
const OUTER_R = 30;
const INNER_R = 18; // bigger body — matches the Starlib logo's chunky proportions
const STAR_THICKNESS = 18;

function buildStarPath() {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? OUTER_R : INNER_R;
    pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
  }
  return pts;
}

function readBrand() {
  if (typeof window === "undefined") {
    return { brand: "#a6e22e" };
  }
  const cs = getComputedStyle(document.documentElement);
  const hue = parseFloat(cs.getPropertyValue("--accent-hue")) || 110;
  const chroma = parseFloat(cs.getPropertyValue("--accent-chroma")) || 0.17;
  return { brand: `oklch(0.78 ${chroma} ${hue})` };
}

const EYE_COLOR = "oklch(0.18 0.02 260)";

export function StarMate({
  size,
  className,
  style,
  seed = 0,
  drift = 1,
  driftDuration = 12,
  driftDelay = 0,
  spin = 0.6,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const launchRef = useRef<HTMLDivElement | null>(null);
  const [expr, setExpr] = useState<Expression>("smile");
  const exprRef = useRef<Expression>("smile");

  useEffect(() => {
    exprRef.current = expr;
  }, [expr]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const tick = () => {
      setExpr(
        EXPRESSION_BAG[Math.floor(Math.random() * EXPRESSION_BAG.length)],
      );
      timeout = setTimeout(tick, 2400 + Math.random() * 3200);
    };
    timeout = setTimeout(tick, 800 + seed * 400);
    return () => clearTimeout(timeout);
  }, [seed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const colors = readBrand();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const zoom = (size * dpr) / (OUTER_R * 2 + STAR_THICKNESS * 1.2 + 16);

    const illo = new Zdog.Illustration({
      element: canvas,
      zoom,
      dragRotate: false,
    });

    // --- Body: chunky rounded star. Thick stroke gives the Starlib silhouette
    // and real 3D extrusion thickness. ---
    new Zdog.Shape({
      addTo: illo,
      path: buildStarPath(),
      closed: true,
      stroke: STAR_THICKNESS,
      color: colors.brand,
      fill: true,
    });

    // --- Face group on the forward surface ---
    const faceGroup = new Zdog.Anchor({
      addTo: illo,
      translate: { z: STAR_THICKNESS / 2 + 0.5 },
    });

    const buildFace = (expression: Expression) => {
      faceGroup.children = [];

      const lx = -7;
      const rx = 7;
      const eyeY = -3;
      const mouthY = 6;

      const openEye = (x: number) => {
        new Zdog.Ellipse({
          addTo: faceGroup,
          diameter: 4.6,
          translate: { x, y: eyeY },
          stroke: 0.8,
          color: EYE_COLOR,
          fill: true,
        });
      };

      const closedEye = (x: number, curve: "up" | "down") => {
        const dy = curve === "up" ? -1.6 : 1.6;
        new Zdog.Shape({
          addTo: faceGroup,
          path: [
            { x: x - 2.6, y: eyeY },
            {
              arc: [
                { x, y: eyeY + dy },
                { x: x + 2.6, y: eyeY },
              ],
            },
          ],
          closed: false,
          stroke: 1.4,
          color: EYE_COLOR,
        });
      };

      const arcMouth = (width: number, dip: number, thickness = 1.4) => {
        new Zdog.Shape({
          addTo: faceGroup,
          path: [
            { x: -width, y: mouthY },
            {
              arc: [
                { x: 0, y: mouthY + dip },
                { x: width, y: mouthY },
              ],
            },
          ],
          closed: false,
          stroke: thickness,
          color: EYE_COLOR,
        });
      };

      const dotMouth = (r: number) => {
        new Zdog.Ellipse({
          addTo: faceGroup,
          diameter: r * 2,
          translate: { y: mouthY + 1 },
          stroke: 0.8,
          color: EYE_COLOR,
          fill: true,
        });
      };

      const ovalMouth = (r: number) => {
        new Zdog.Ellipse({
          addTo: faceGroup,
          diameter: r * 2,
          translate: { y: mouthY + 2 },
          stroke: 0.8,
          color: EYE_COLOR,
          fill: true,
        });
      };

      // Eyes
      if (expression === "wink") {
        openEye(lx);
        closedEye(rx, "down");
      } else if (expression === "sleepy" || expression === "yawn") {
        closedEye(lx, "down");
        closedEye(rx, "down");
      } else if (expression === "happy") {
        closedEye(lx, "up");
        closedEye(rx, "up");
      } else if (expression === "surprised") {
        new Zdog.Ellipse({
          addTo: faceGroup,
          diameter: 3.4,
          translate: { x: lx, y: eyeY },
          stroke: 0.6,
          color: EYE_COLOR,
          fill: true,
        });
        new Zdog.Ellipse({
          addTo: faceGroup,
          diameter: 3.4,
          translate: { x: rx, y: eyeY },
          stroke: 0.6,
          color: EYE_COLOR,
          fill: true,
        });
      } else {
        openEye(lx);
        openEye(rx);
      }

      // Mouth
      if (expression === "surprised") {
        dotMouth(1.6);
      } else if (expression === "yawn") {
        ovalMouth(3.2);
      } else if (expression === "sleepy") {
        arcMouth(2, -1, 1.2);
      } else if (expression === "happy") {
        arcMouth(6, 4, 1.6);
      } else {
        arcMouth(4.5, 3, 1.4);
      }
    };
    buildFace("smile");

    // --- Animation + physics ---
    let raf = 0;
    let lastTime = performance.now();
    let rotY = (seed * Math.PI) / 3;
    let extraRotX = 0;
    let extraRotZ = 0;
    const vel = { x: 0, y: 0, z: 0 };
    const pos = { x: 0, y: 0 };
    const launchVel = { x: 0, y: 0 };
    let lastExpr: Expression = "smile";

    const onClick = () => {
      const jitter = (Math.random() - 0.5) * Math.PI * 0.8;
      const awayAngle =
        Math.abs(pos.x) + Math.abs(pos.y) > 20
          ? Math.atan2(pos.y, pos.x) + Math.PI + jitter
          : Math.random() * Math.PI * 2;
      const SPEED = 520 + Math.random() * 200;
      launchVel.x += Math.cos(awayAngle) * SPEED;
      launchVel.y += Math.sin(awayAngle) * SPEED;
      const ROT_KICK = 10;
      vel.y += Math.cos(awayAngle) * ROT_KICK;
      vel.x += Math.sin(awayAngle) * ROT_KICK;
      vel.z += (Math.random() - 0.5) * 8;
    };
    canvas.addEventListener("click", onClick);

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      if (exprRef.current !== lastExpr) {
        lastExpr = exprRef.current;
        buildFace(lastExpr);
      }

      rotY += dt * (spin + vel.y);
      extraRotX += dt * vel.x;
      extraRotZ += dt * vel.z;

      const velDecay = Math.exp(-dt * 2.2);
      vel.x *= velDecay;
      vel.y *= velDecay;
      vel.z *= velDecay;
      const rotDecay = Math.exp(-dt * 0.9);
      extraRotX *= rotDecay;
      extraRotZ *= rotDecay;

      pos.x += dt * launchVel.x;
      pos.y += dt * launchVel.y;
      const launchVelDecay = Math.exp(-dt * 1.6);
      launchVel.x *= launchVelDecay;
      launchVel.y *= launchVelDecay;
      const posDecay = Math.exp(-dt * 0.45);
      pos.x *= posDecay;
      pos.y *= posDecay;

      if (launchRef.current) {
        launchRef.current.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`;
      }

      const baseX = Math.sin(now * 0.0006 + seed) * 0.28;
      const baseZ = Math.sin(now * 0.00045 + seed * 0.7) * 0.18;

      illo.rotate.y = rotY;
      illo.rotate.x = baseX + extraRotX;
      illo.rotate.z = baseZ + extraRotZ;

      illo.updateRenderGraph();
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
    };
  }, [size, seed, spin]);

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: "absolute",
        width: size,
        height: size,
        animation: `star-drift-${drift} ${driftDuration}s ease-in-out infinite`,
        animationDelay: `${driftDelay}s`,
        pointerEvents: "none",
        ...style,
      }}
    >
      <div
        ref={launchRef}
        style={{ position: "absolute", inset: 0, willChange: "transform" }}
      >
        <canvas
          ref={canvasRef}
          style={{
            pointerEvents: "auto",
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        />
      </div>
    </div>
  );
}
