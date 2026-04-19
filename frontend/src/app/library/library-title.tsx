"use client";

import { FolderTree } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { cn } from "@/lib/utils";

import { SOURCE_IDS, type SourceId } from "./sources";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const SOURCE_META: Record<SourceId, { label: string; icon: IconComponent }> = {
  filesystem: { label: "Filesystem", icon: FolderTree },
  soundcloud: { label: "SoundCloud", icon: SoundCloudLogo },
};

/**
 * Title prefix shared by both source views: "Library" label + source switcher.
 *
 * The switcher shows the active source as icon + label; inactive sources are
 * icon-only and reveal their label on hover (animated width).
 */
export function LibraryTitle({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = (params.get("source") ?? "filesystem") as SourceId;

  return (
    <>
      <span>Library</span>
      <div className="bg-border mx-1 h-5 w-px shrink-0" />
      <div
        role="tablist"
        aria-label="Library source"
        className="border-border bg-card inline-flex h-7 items-center gap-0.5 rounded-md border p-0.5"
      >
        {SOURCE_IDS.map((id) => {
          const active = id === current;
          const meta = SOURCE_META[id];
          const Icon = meta.icon;
          const href = `${pathname}?source=${id}`;
          return (
            <Link
              key={id}
              href={href}
              role="tab"
              aria-selected={active}
              aria-label={meta.label}
              className={cn(
                "group flex h-6 items-center rounded-sm px-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-brand-soft text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap transition-[max-width,margin-left,opacity] duration-200 ease-out",
                  active
                    ? "ml-1.5 max-w-32 opacity-100"
                    : "ml-0 max-w-0 opacity-0 group-hover:ml-1.5 group-hover:max-w-32 group-hover:opacity-100",
                )}
              >
                {meta.label}
              </span>
            </Link>
          );
        })}
      </div>
      {children && (
        <>
          <div className="bg-border mx-1 h-5 w-px shrink-0" />
          <div className="flex items-center gap-2">{children}</div>
        </>
      )}
    </>
  );
}
