"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import Link from "next/link";
import { useEffect, useState } from "react";

import { CommandPaletteTrigger } from "@/components/command-palette";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { useTopBarContent } from "./top-bar-context";

function useIsFullscreen() {
  // Initial value stays `false` to match SSR (where `isTauri()` is always
  // false). The client effect then either subscribes to Tauri window state
  // or — outside Tauri (web preview, doc screenshots) — pins it to `true`
  // so the topbar doesn't carry an 80 px gutter reserved for macOS
  // traffic-light buttons that don't exist.
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      // One-shot client upgrade from the SSR-safe `false`. Not a cascading
      // render — fires once on mount and never again.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFullscreen(true);
      return;
    }
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    const sync = () => {
      void w.isFullscreen().then(setFullscreen);
    };
    sync();
    w.onResized(sync).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return fullscreen;
}

export function TopBar() {
  const { title, actions } = useTopBarContent();
  const fullscreen = useIsFullscreen();

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "border-border bg-card fixed top-0 right-0 left-0 z-40 flex h-11 items-center gap-3 border-b pr-4 transition-[padding]",
        fullscreen ? "pl-4" : "pl-20",
      )}
    >
      <Link href="/" aria-label="Starlib home" className="shrink-0">
        <span
          className="bg-primary block size-5"
          style={{
            maskImage: "url(/starlib-logo.svg)",
            WebkitMaskImage: "url(/starlib-logo.svg)",
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
        {title ?? null}
      </div>
      <div className="hidden shrink-0 sm:block">
        <CommandPaletteTrigger />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {actions}
      </div>
    </header>
  );
}
