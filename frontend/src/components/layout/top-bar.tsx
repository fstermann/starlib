"use client";

import { CommandPaletteTrigger } from "@/components/command-palette";

import { useTopBarContent } from "./top-bar-context";

export function TopBar() {
  const { title, actions } = useTopBarContent();

  return (
    <header className="border-border bg-card fixed top-0 right-0 left-14 z-40 flex h-11 items-center gap-3 border-b px-4">
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
