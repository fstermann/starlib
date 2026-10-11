import { useState } from "react";

/** True on the render where any of `deps` differs from the last render (and
 *  on mount). Lets a component reset state while rendering instead of in an
 *  effect: `if (useChanged([id])) setDraft("")`. */
export function useChanged(deps: readonly unknown[]): boolean {
  const [prev, setPrev] = useState<readonly unknown[] | null>(null);
  const changed =
    prev === null ||
    prev.length !== deps.length ||
    deps.some((d, i) => !Object.is(d, prev[i]));
  if (changed) setPrev(deps);
  return changed;
}
