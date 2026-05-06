import type { ComponentType, SVGProps } from "react";

import { cn } from "@/lib/utils";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Tab content: icon always visible, label collapses to width 0 when inactive
 * and expands on hover or when active. Parent must declare `group` so the
 * hover state cascades to the label span.
 */
export function AutoHideTabLabel({
  icon: Icon,
  label,
  active,
  iconClassName,
}: {
  icon: IconComponent;
  label: string;
  active: boolean;
  iconClassName?: string;
}) {
  return (
    <>
      <Icon className={cn("size-3.5 shrink-0", iconClassName)} />
      <span
        className={cn(
          "overflow-hidden whitespace-nowrap transition-[max-width,margin-left,opacity] duration-200 ease-out",
          active
            ? "ml-1.5 max-w-32 opacity-100"
            : "ml-0 max-w-0 opacity-0 group-hover:ml-1.5 group-hover:max-w-32 group-hover:opacity-100",
        )}
      >
        {label}
      </span>
    </>
  );
}
