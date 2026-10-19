"use client";

import { useCallback, useEffect, useState } from "react";

import type { BellEq } from "@/lib/eq";
import { glide, hasOutput, outputFor } from "@/lib/media-output";

const STORAGE_KEY = "starlib.breakdown.previewEq";
// Parameter changes glide over this long so dragging a slider doesn't click.
const GLIDE_S = 0.03;

const DEFAULT_EQ: BellEq = {
  on: false,
  freqHz: 3000,
  gainDb: 1,
  q: 0.7,
};

function readStored(): BellEq {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_EQ, ...JSON.parse(raw) } : DEFAULT_EQ;
  } catch {
    return DEFAULT_EQ;
  }
}

export interface PreviewEq {
  eq: BellEq;
  setEq: (patch: Partial<BellEq>) => void;
  reset: () => void;
}

/** A bell EQ on the set player, to hear a master change before rendering it. */
export function usePreviewEq(media: HTMLMediaElement | null): PreviewEq {
  const [eq, setEqState] = useState<BellEq>(readStored);

  const setEq = useCallback((patch: Partial<BellEq>) => {
    setEqState((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode or blocked storage: the settings just aren't remembered.
      }
      return next;
    });
  }, []);

  const reset = useCallback(
    () => setEq({ ...DEFAULT_EQ, on: eq.on }),
    [eq.on, setEq],
  );

  useEffect(() => {
    // Leave the player untouched until the EQ is first switched on.
    if (!media || (!eq.on && !hasOutput(media))) return;
    const { filter } = outputFor(media);
    glide(filter.frequency, eq.freqHz, GLIDE_S);
    glide(filter.Q, eq.q, GLIDE_S);
    glide(filter.gain, eq.on ? eq.gainDb : 0, GLIDE_S);
  }, [media, eq]);

  return { eq, setEq, reset };
}
