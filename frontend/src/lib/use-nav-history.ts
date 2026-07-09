"use client";

import { useEffect, useState } from "react";

// Browser-style back/forward needs to know the current position within the
// session history and whether entries exist on either side. Neither the DOM
// History API nor the Next.js App Router exposes that, so we track it: we tag
// every history entry with a monotonic index (merged into whatever state Next
// already stores) and read it back on `popstate`.

type NavState = { canGoBack: boolean; canGoForward: boolean };

const INDEX_KEY = "__starlibNavIdx";

let currentIndex = 0;
let maxIndex = 0;
let installed = false;

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function readIndex(state: unknown): number | undefined {
  if (state && typeof state === "object" && INDEX_KEY in state) {
    const v = (state as Record<string, unknown>)[INDEX_KEY];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const { history } = window;
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  // Seed the current entry. A reload preserves history.state, so recover the
  // index if we set one before; forward entries can't be recovered, so treat
  // the current position as the end (forward disabled until we navigate again).
  const seeded = readIndex(history.state);
  currentIndex = seeded ?? 0;
  maxIndex = currentIndex;
  origReplace({ ...(history.state ?? {}), [INDEX_KEY]: currentIndex }, "");

  history.pushState = function (state, unused, url) {
    // A push truncates any forward history.
    currentIndex += 1;
    maxIndex = currentIndex;
    origPush({ ...(state ?? {}), [INDEX_KEY]: currentIndex }, unused, url);
    // Next.js drives pushState from an insertion effect, where scheduling a
    // React update synchronously warns. Defer to a microtask.
    queueMicrotask(notify);
  };

  history.replaceState = function (state, unused, url) {
    // A replace keeps the index, so nav-arrow state is unchanged — no notify.
    // (Next.js calls this during an insertion effect, where scheduling a React
    // update would warn.)
    origReplace({ ...(state ?? {}), [INDEX_KEY]: currentIndex }, unused, url);
  };

  window.addEventListener("popstate", (e) => {
    const idx = readIndex(e.state) ?? 0;
    currentIndex = idx;
    if (idx > maxIndex) maxIndex = idx;
    notify();
  });
}

function snapshot(): NavState {
  return {
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex < maxIndex,
  };
}

export function useNavHistory() {
  const [state, setState] = useState<NavState>({
    canGoBack: false,
    canGoForward: false,
  });

  useEffect(() => {
    install();
    const update = () => setState(snapshot());
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);

  const back = () => {
    if (state.canGoBack) window.history.back();
  };
  const forward = () => {
    if (state.canGoForward) window.history.forward();
  };

  return { ...state, back, forward };
}
