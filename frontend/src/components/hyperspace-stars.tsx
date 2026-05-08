"use client";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { StarMate } from "@/components/home/star-mate";

type Phase = "travel" | "exit" | "done";
type Stage = "entrance" | "cruise";

const ENTRANCE_MS = 500;
const ORBIT_MS = 4000;
const EXIT_MS = 550;

// Cruise is a circular orbit around screen center — a "tunnel" of stars
// rotating around the camera axis.
const ORBIT_RADIUS = 110;
const ORBIT_SAMPLES = 32;

// Mirrors the placements that used to live in floating-stars.tsx so the
// loader's racing stars settle into the exact title-screen layout.
const STARS = [
  {
    size: 64,
    seed: 0 as const,
    drift: 1 as const,
    driftDuration: 13,
    spin: 0.55,
    // top: 16%, right: 12%
    home: (vw: number, vh: number, size: number) => ({
      x: vw * (1 - 0.12) - size,
      y: vh * 0.16,
    }),
  },
  {
    size: 50,
    seed: 1 as const,
    drift: 2 as const,
    driftDuration: 17,
    driftDelay: -4,
    spin: -0.4,
    // top: 42%, left: 12%
    home: (vw: number, vh: number) => ({ x: vw * 0.12, y: vh * 0.42 }),
  },
  {
    size: 40,
    seed: 2 as const,
    drift: 3 as const,
    driftDuration: 15,
    driftDelay: -7,
    spin: 0.7,
    // top: 30%, right: 6%
    home: (vw: number, vh: number, size: number) => ({
      x: vw * (1 - 0.06) - size,
      y: vh * 0.3,
    }),
  },
];

/**
 * Three StarMates that race through hyperspace and end up as the home page's
 * floating stars. Mounted once at app start and never remounted, so the same
 * React instances (and Zdog canvases) hand off cleanly: no fade, no flicker.
 *
 * Stages:
 * - entrance: one-shot fly-in from screen center to each star's orbit slot
 * - cruise:   continuous orbit around screen center while the backend loads
 * - exit:     tween from the current orbit position to the title-screen home
 *
 * Visible only on the home route — they belong to the title screen.
 */
export function HyperspaceStars({ phase }: { phase: Phase }) {
  const pathname = usePathname();
  const [size, setSize] = useState({ vw: 0, vh: 0 });
  const [stage, setStage] = useState<Stage>("entrance");

  useEffect(() => {
    const onResize = () =>
      setSize({ vw: window.innerWidth, vh: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (phase !== "travel") return;
    const t = setTimeout(() => setStage("cruise"), ENTRANCE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (size.vw === 0) return null;
  if (pathname !== "/") return null;

  const cx = size.vw / 2;
  const cy = size.vh / 2;

  return (
    <>
      {STARS.map((s, i) => {
        const home = s.home(size.vw, size.vh, s.size);
        // Top-left of the star when centered on screen.
        const startX = cx - s.size / 2;
        const startY = cy - s.size / 2;

        // Each star starts at a different angle so they spread around the
        // circle instead of stacking.
        const startAngle = (i / STARS.length) * Math.PI * 2;
        const orbitX = (a: number) => startX + Math.cos(a) * ORBIT_RADIUS;
        const orbitY = (a: number) => startY + Math.sin(a) * ORBIT_RADIUS;

        const arrived = phase === "done";
        const cruising = phase === "travel" && stage === "cruise";
        const entering = phase === "travel" && stage === "entrance";

        let animate: Parameters<typeof motion.div>[0]["animate"];
        let transition: Parameters<typeof motion.div>[0]["transition"];

        if (entering) {
          animate = {
            x: orbitX(startAngle),
            y: orbitY(startAngle),
            scale: 1,
            opacity: 1,
          };
          transition = {
            duration: ENTRANCE_MS / 1000,
            ease: [0.2, 0, 0, 1],
          };
        } else if (cruising) {
          // Start and end angles differ by exactly 2π, so the loop seam
          // is a no-op — no fade, no teleport.
          const angles = Array.from(
            { length: ORBIT_SAMPLES + 1 },
            (_, k) => startAngle + (k / ORBIT_SAMPLES) * Math.PI * 2,
          );
          animate = {
            x: angles.map(orbitX),
            y: angles.map(orbitY),
            scale: 1,
            opacity: 1,
          };
          transition = {
            duration: ORBIT_MS / 1000,
            repeat: Infinity,
            ease: "linear",
          };
        } else {
          // exit / done
          animate = { x: home.x, y: home.y, scale: 1, opacity: 1 };
          transition = {
            duration: arrived ? 0 : EXIT_MS / 1000,
            ease: [0.2, 0, 0, 1],
          };
        }

        return (
          <motion.div
            key={s.seed}
            aria-hidden="true"
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: s.size,
              height: s.size,
              zIndex: 101,
              pointerEvents: "none",
              willChange: "transform",
            }}
            initial={
              phase === "done"
                ? { x: home.x, y: home.y, scale: 1, opacity: 1 }
                : { x: startX, y: startY, scale: 0.05, opacity: 0 }
            }
            animate={animate}
            transition={transition}
          >
            <StarMate
              size={s.size}
              seed={s.seed}
              drift={s.drift}
              driftDuration={s.driftDuration}
              driftDelay={s.driftDelay}
              spin={s.spin}
            />
          </motion.div>
        );
      })}
    </>
  );
}
