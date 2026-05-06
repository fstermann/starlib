"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { SourceProfile } from "@/lib/profile-groups";

interface Props {
  sources: SourceProfile[] | undefined;
}

/** Avatar cell for the Discover-group source-profile column.
 *
 * Renders the first source's avatar with a `+N` numeric badge when the
 * track was liked by multiple group members. Tooltip lists every member's
 * username. Hidden gracefully when `sources` is empty (single-member
 * Discover doesn't render this column at all). */
export function SourceProfileAvatar({ sources }: Props) {
  if (!sources || sources.length === 0) return null;
  const first = sources[0];
  const avatarUrl = first.avatar_url ? api.proxyImageUrl(first.avatar_url) : null;
  const extra = sources.length - 1;
  const tooltipText = sources.map((s) => s.username).join(", ");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative flex items-center">
            <div className="bg-muted flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-5 object-cover" />
              ) : (
                <span className="text-muted-foreground text-[10px] font-medium">
                  {(first.username ?? "?")[0]?.toUpperCase()}
                </span>
              )}
            </div>
            {extra > 0 && (
              <span className="text-muted-foreground ml-1 text-[10px] tabular-nums">
                +{extra}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
