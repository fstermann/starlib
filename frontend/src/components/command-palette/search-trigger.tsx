"use client";

import { Search } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { useCommandPalette } from "./provider";

const emptySubscribe = () => () => {};
function detectMac() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

/**
 * Input-shaped button that opens the command palette. Rendered in the top bar
 * so users who don't know the ⌘P shortcut can still discover the palette.
 */
export function CommandPaletteTrigger({ className }: { className?: string }) {
  const { setOpen } = useCommandPalette();
  const isMac = useSyncExternalStore(emptySubscribe, detectMac, () => false);

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open command palette"
      className={cn(
        "bg-background text-muted-foreground hover:text-foreground hover:border-foreground/20 flex h-6 w-56 max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        className,
      )}
    >
      <Search className="size-3 shrink-0" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="bg-muted text-muted-foreground pointer-events-none inline-flex h-4 items-center gap-0.5 rounded border px-1 font-mono text-[9px] font-medium select-none">
        {isMac ? "⌘" : "Ctrl"}
        <span className="text-[10px]">P</span>
      </kbd>
    </button>
  );
}
