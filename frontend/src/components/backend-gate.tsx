"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useState } from "react";

import { HyperspaceLoader } from "@/components/hyperspace-loader";
import { HyperspaceStars } from "@/components/hyperspace-stars";
import { api } from "@/lib/api";

const POLL_INTERVAL_MS = 500;
// Just long enough for the StarMate fly-in to complete so we don't
// reverse direction mid-flight. After that, exit as soon as backend ready.
const MIN_TRAVEL_MS = 500;
// Deceleration window from "exit" trigger to fully unmounting the loader.
const EXIT_MS = 700;

type Phase = "travel" | "exit" | "done";

function isReload(): boolean {
  if (typeof window === "undefined") return false;
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return nav?.type === "reload";
}

// useLayoutEffect warns during SSR; swap to useEffect on the server.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function BackendGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("travel");
  // First render returns null so the loader never mounts on reload —
  // otherwise AnimatePresence plays a 700ms exit fade on the way out.
  const [initialized, setInitialized] = useState(false);

  useIsoLayoutEffect(() => {
    if (isReload()) {
      setPhase("done");
      setInitialized(true);
      return;
    }
    setInitialized(true);
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const start = performance.now();

    async function run() {
      while (!cancelled) {
        try {
          await api.healthCheck();
          break;
        } catch {
          await new Promise((r) => {
            const id = setTimeout(r, POLL_INTERVAL_MS);
            timeouts.push(id);
          });
        }
      }
      if (cancelled) return;

      const elapsed = performance.now() - start;
      const remaining = Math.max(0, MIN_TRAVEL_MS - elapsed);
      timeouts.push(
        setTimeout(() => {
          if (cancelled) return;
          setPhase("exit");
          timeouts.push(
            setTimeout(() => {
              if (!cancelled) setPhase("done");
            }, EXIT_MS),
          );
        }, remaining),
      );
    }

    run();
    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
  }, []);

  if (!initialized) return null;

  return (
    <>
      <AnimatePresence>
        {phase !== "done" && (
          <motion.div
            key="hyperspace"
            className={`bg-background fixed inset-0 z-100 overflow-hidden ${
              phase === "exit" ? "pointer-events-none" : ""
            }`}
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: EXIT_MS / 1000, ease: [0.4, 0, 1, 1] }}
          >
            <HyperspaceLoader phase={phase === "exit" ? "exit" : "travel"} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* StarMates persist across travel → exit → done so the same React
          instances (and Zdog canvases) literally land at the title-screen
          positions — no fade, no remount. */}
      <HyperspaceStars phase={phase} />

      {phase !== "travel" && children}
    </>
  );
}
