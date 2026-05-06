"use client";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { StarMate } from "@/components/home/star-mate";

type Phase = "travel" | "exit" | "done";
type Stage = "entrance" | "cruise";

const ENTRANCE_MS = 600;
const CRUISE_MS = 700;
const EXIT_MS = 550;

// How far along each star's trajectory the cruise loop runs.
// Cruise sits between the camera and well past the home position so the
// streak feels like constant outward flight. The home position sits inside
// the cruise window — when exit lands at scale 1 there, it's a clean
// deceleration out of the loop.
const CRUISE_START = 0.25; // along ray, scale 0.5
const CRUISE_END = 2.4; // along ray, off-screen, scale 3
const CRUISE_OVERSHOOT = 2.55; // a hair further so opacity-fade lands off-screen

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
 * - entrance: one-shot fly-in from screen center to the cruise start
 * - cruise:   continuous outward streak while the backend keeps loading
 * - exit:     decelerate to the title-screen home positions
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
        const dx = home.x - startX;
        const dy = home.y - startY;

        // Cruise endpoints along the ray from screen-center toward home.
        const cruiseStartX = startX + dx * CRUISE_START;
        const cruiseStartY = startY + dy * CRUISE_START;
        const cruiseEndX = startX + dx * CRUISE_END;
        const cruiseEndY = startY + dy * CRUISE_END;
        const cruiseOverX = startX + dx * CRUISE_OVERSHOOT;
        const cruiseOverY = startY + dy * CRUISE_OVERSHOOT;

        const arrived = phase === "done";
        const cruising = phase === "travel" && stage === "cruise";
        const entering = phase === "travel" && stage === "entrance";

        let animate: Parameters<typeof motion.div>[0]["animate"];
        let transition: Parameters<typeof motion.div>[0]["transition"];

        if (entering) {
          animate = {
            x: cruiseStartX,
            y: cruiseStartY,
            scale: 0.5,
            opacity: 1,
          };
          transition = {
            duration: ENTRANCE_MS / 1000,
            ease: [0.2, 0, 0, 1],
          };
        } else if (cruising) {
          // 5 keyframes: visible streak → fade out at far → invisible
          // teleport back to cruise start → fade in. The teleport happens
          // entirely while opacity is 0, so the loop seam is invisible.
          animate = {
            x: [
              cruiseStartX,
              cruiseEndX,
              cruiseOverX,
              cruiseStartX,
              cruiseStartX,
            ],
            y: [
              cruiseStartY,
              cruiseEndY,
              cruiseOverY,
              cruiseStartY,
              cruiseStartY,
            ],
            scale: [0.5, 3, 3.3, 0.5, 0.5],
            opacity: [1, 1, 0, 0, 1],
          };
          transition = {
            duration: CRUISE_MS / 1000,
            repeat: Infinity,
            ease: "linear",
            times: [0, 0.85, 0.92, 0.93, 1],
            delay: i * 0.08,
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
