'use client';

import { usePlayer } from '@/lib/player-context';
import { cn } from '@/lib/utils';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const { currentTrack, largePlayer } = usePlayer();
  return (
    <main
      className={cn(
        'flex-1 min-w-0 ml-14 mt-11 flex flex-col overflow-hidden transition-[padding] duration-200 ease-out',
        currentTrack && largePlayer && 'pb-17'
      )}
    >
      {children}
    </main>
  );
}
