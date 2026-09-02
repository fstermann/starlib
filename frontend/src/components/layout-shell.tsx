"use client";

import { usePlayer } from "@/lib/player-context";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const { currentTrack } = usePlayer();
  return (
    <main
      className="mt-11 ml-14 flex min-w-0 flex-1 flex-col overflow-hidden transition-[padding] duration-200 ease-out"
      // Reserve exactly the player's height (published as --player-height); 0
      // when nothing is playing.
      style={{ paddingBottom: currentTrack ? "var(--player-height, 4rem)" : 0 }}
    >
      {children}
    </main>
  );
}
