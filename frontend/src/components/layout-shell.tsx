'use client';

import { usePlayer } from '@/lib/player-context';
import { cn } from '@/lib/utils';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const { currentTrack } = usePlayer();
  return (
    <main
      className={cn(
        'flex-1 min-w-0 ml-14 flex flex-col overflow-hidden',
        currentTrack && 'pb-17'
      )}
    >
      {children}
    </main>
  );
}
