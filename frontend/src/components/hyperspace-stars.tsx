"use client";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { StarMate } from "@/components/home/star-mate";

type Phase = "travel" | "exit" | "done";

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
 * Visible only on the home route — they belong to the title screen.
 */
export function HyperspaceStars({ phase }: { phase: Phase }) {
  const pathname = usePathname();
  const [size, setSize] = useState({ vw: 0, vh: 0 });

  useEffect(() => {
    const onResize = () =>
      setSize({ vw: window.innerWidth, vh: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
        const dx = home.x - startX;
        const dy = home.y - startY;

        const racing = phase === "travel";
        const arrived = phase === "done";

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
            initial={{ x: startX, y: startY, scale: 0.05, opacity: 0 }}
            animate={
              racing
                ? {
                    // Trajectory points at the eventual home position so the
                    // stars race toward where they'll land.
                    x: [
                      startX,
                      startX + dx * 0.55,
                      startX + dx * 1.0,
                      startX + dx * 1.7,
                    ],
                    y: [
                      startY,
                      startY + dy * 0.55,
                      startY + dy * 1.0,
                      startY + dy * 1.7,
                    ],
                    scale: [0.05, 0.55, 1, 2.2],
                    opacity: [0, 1, 1, 0],
                  }
                : { x: home.x, y: home.y, scale: 1, opacity: 1 }
            }
            transition={
              racing
                ? {
                    duration: 1.0,
                    repeat: Infinity,
                    delay: i * 0.18,
                    ease: [0.45, 0, 0.9, 0.4],
                    times: [0, 0.3, 0.65, 1],
                  }
                : {
                    duration: arrived ? 0 : 0.55,
                    ease: [0.2, 0, 0, 1],
                  }
            }
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
