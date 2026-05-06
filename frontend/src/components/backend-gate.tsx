"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

import { HyperspaceLoader } from "@/components/hyperspace-loader";
import { HyperspaceStars } from "@/components/hyperspace-stars";
import { LoaderPhaseProvider } from "@/components/loader-phase-context";
import { api } from "@/lib/api";

const POLL_INTERVAL_MS = 500;
// Minimum time the hyperspace effect plays even if the backend answers
// instantly — gives the animation a beat to land.
const MIN_TRAVEL_MS = 1100;
// Deceleration window from "exit" trigger to fully unmounting the loader.
const EXIT_MS = 700;

type Phase = "travel" | "exit" | "done";

export function BackendGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("travel");

  useEffect(() => {
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

  return (
    <>
      <AnimatePresence>
        {phase !== "done" && (
          <motion.div
            key="hyperspace"
            className={`bg-background fixed inset-0 z-100 flex items-center justify-center overflow-hidden ${
              phase === "exit" ? "pointer-events-none" : ""
            }`}
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: EXIT_MS / 1000, ease: [0.4, 0, 1, 1] }}
          >
            <HyperspaceLoader phase={phase === "exit" ? "exit" : "travel"} />
            <HyperspaceStars phase={phase === "exit" ? "exit" : "travel"} />
          </motion.div>
        )}
      </AnimatePresence>

      {phase !== "travel" && (
        <LoaderPhaseProvider value={phase}>{children}</LoaderPhaseProvider>
      )}
    </>
  );
}
