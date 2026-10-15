import { useEffect, useRef } from "react";

import { CANVASES_LOST_EVENT } from "./tauri";

let restarts = 0;
if (typeof window !== "undefined")
  window.addEventListener(CANVASES_LOST_EVENT, () => restarts++);

/**
 * Whether `canvas` still holds a backing store from before the last GPU
 * process restart; reassigning its width allocates a fresh one.
 */
export function hasLostBackingStore(canvas: HTMLCanvasElement): boolean {
  const lost = canvas.dataset.gpuRestarts !== String(restarts);
  canvas.dataset.gpuRestarts = String(restarts);
  return lost;
}

/** Call `redraw` once the GPU process restarts, which blanks every canvas. */
export function useRedrawOnCanvasesLost(redraw: () => void): void {
  const latest = useRef(redraw);
  useEffect(() => {
    latest.current = redraw;
  });
  useEffect(() => {
    const onLost = () => latest.current();
    window.addEventListener(CANVASES_LOST_EVENT, onLost);
    return () => window.removeEventListener(CANVASES_LOST_EVENT, onLost);
  }, []);
}
