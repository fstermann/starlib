"use client";

import { useLoaderPhase } from "@/components/loader-phase-context";

import { StarMate } from "./star-mate";

export function FloatingStars() {
  // Hide while the hyperspace loader is racing its own stars in — they
  // animate to these exact positions, so we mount only once the loader is
  // gone to avoid a duplicated set during the handoff.
  const phase = useLoaderPhase();
  if (phase !== "done") return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[2]"
    >
      <StarMate
        size={64}
        seed={0}
        drift={1}
        driftDuration={13}
        spin={0.55}
        style={{ top: "16%", right: "12%" }}
      />
      <StarMate
        size={50}
        seed={1}
        drift={2}
        driftDuration={17}
        driftDelay={-4}
        spin={-0.4}
        style={{ top: "42%", left: "12%" }}
      />
      <StarMate
        size={40}
        seed={2}
        drift={3}
        driftDuration={15}
        driftDelay={-7}
        spin={0.7}
        style={{ top: "30%", right: "6%" }}
      />
    </div>
  );
}
