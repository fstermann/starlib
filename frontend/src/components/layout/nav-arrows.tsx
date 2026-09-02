"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect } from "react";

import { useNavHistory } from "@/lib/use-nav-history";
import { cn } from "@/lib/utils";

export function NavArrows() {
  const { canGoBack, canGoForward, back, forward } = useNavHistory();

  // Browser-style ⌘[ / ⌘] (Ctrl+[ / Ctrl+] on Windows/Linux). These aren't
  // text-editing shortcuts, so it's safe to bind them globally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[") {
        e.preventDefault();
        back();
      } else if (e.key === "]") {
        e.preventDefault();
        forward();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, forward]);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={back}
        disabled={!canGoBack}
        aria-label="Go back"
        title="Go back (⌘[)"
        className={cn(
          "hover:bg-accent text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md transition-colors",
          canGoBack ? "cursor-pointer" : "cursor-not-allowed opacity-40",
        )}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={forward}
        disabled={!canGoForward}
        aria-label="Go forward"
        title="Go forward (⌘])"
        className={cn(
          "hover:bg-accent text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md transition-colors",
          canGoForward ? "cursor-pointer" : "cursor-not-allowed opacity-40",
        )}
      >
        <ArrowRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
