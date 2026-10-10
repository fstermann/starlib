"use client";

import { AudioLines, ListMusic } from "lucide-react";
import Link from "next/link";
import type { ComponentType, SVGProps } from "react";

import { AutoHideTabLabel } from "@/components/auto-hide-tab-label";
import { cn } from "@/lib/utils";

export const BREAKDOWN_VIEWS = ["set", "track"] as const;
export type BreakdownView = (typeof BREAKDOWN_VIEWS)[number];

const VIEW_META: Record<
  BreakdownView,
  { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  set: { label: "Set", icon: ListMusic },
  track: { label: "Track", icon: AudioLines },
};

/** Top-bar title for /breakdown: "Breakdown" plus the Set / Track view switcher. */
export function BreakdownTitle({
  view,
  children,
}: {
  view: BreakdownView;
  children?: React.ReactNode;
}) {
  return (
    <>
      <span>Breakdown</span>
      <div className="mx-1 h-5 w-px shrink-0 bg-[var(--border)]" />
      <div
        role="tablist"
        aria-label="Breakdown view"
        className="inline-flex h-7 items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
      >
        {BREAKDOWN_VIEWS.map((id) => {
          const active = id === view;
          const meta = VIEW_META[id];
          return (
            <Link
              key={id}
              href={`/breakdown?view=${id}`}
              role="tab"
              aria-selected={active}
              aria-label={meta.label}
              className={cn(
                "group flex h-6 items-center rounded-sm px-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]",
              )}
            >
              <AutoHideTabLabel
                icon={meta.icon}
                label={meta.label}
                active={active}
              />
            </Link>
          );
        })}
      </div>
      {children && (
        <>
          <div className="mx-1 h-5 w-px shrink-0 bg-[var(--border)]" />
          <div className="flex min-w-0 items-center gap-2">{children}</div>
        </>
      )}
    </>
  );
}
