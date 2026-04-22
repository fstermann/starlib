"use client";

import { usePlayer } from "@/lib/player-context";
import { cn } from "@/lib/utils";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const { currentTrack } = usePlayer();
  return (
    <main
      className={cn(
        "mt-11 ml-14 flex min-w-0 flex-1 flex-col overflow-hidden transition-[padding] duration-200 ease-out",
        currentTrack && "pb-16",
      )}
    >
      {children}
    </main>
  );
}
