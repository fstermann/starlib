"use client";

import { ChevronDown, Plus, Settings2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import type {
  ProfileGroup,
  ProfileGroupMember,
} from "@/lib/profile-groups";
import { TRANSIENT_GROUP_ID } from "@/lib/profile-groups";

const MAX_VISIBLE_AVATARS = 4;

interface Props {
  /** The active group, transient or persisted. */
  group: { id: string; name: string; members: ProfileGroupMember[] };
  /** All persisted groups, for the picker dropdown. */
  savedGroups: ProfileGroup[];
  onPick: (id: string) => void;
  onNew: () => void;
  onManage: () => void;
  onClear: () => void;
}

export function GroupBar({
  group,
  savedGroups,
  onPick,
  onNew,
  onManage,
  onClear,
}: Props) {
  const isTransient = group.id === TRANSIENT_GROUP_ID || !group.id;
  const visible = group.members.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = group.members.length - visible.length;

  return (
    <div
      className="border-border bg-card flex items-center gap-3 rounded-lg border px-4 py-3"
      data-testid="group-bar"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="hover:bg-accent flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 py-0.5 transition-colors"
            data-testid="group-bar-picker"
          >
            <div className="flex shrink-0 -space-x-2">
              {visible.length === 0 ? (
                <div className="bg-muted flex size-10 items-center justify-center rounded-full">
                  <Plus className="text-muted-foreground size-4" />
                </div>
              ) : (
                visible.map((m) => {
                  const url = m.avatar_url
                    ? api.proxyImageUrl(m.avatar_url)
                    : null;
                  return (
                    <div
                      key={m.user_urn}
                      className="border-card bg-muted flex size-10 items-center justify-center overflow-hidden rounded-full border-2"
                      title={m.username}
                    >
                      {url ? (
                        <img src={url} alt="" className="size-10 object-cover" />
                      ) : (
                        <span className="text-muted-foreground text-sm font-medium">
                          {(m.username ?? "?")[0]?.toUpperCase()}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
              {overflow > 0 && (
                <div className="border-card bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full border-2 text-xs font-medium tabular-nums">
                  +{overflow}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-medium">
                {group.name || (isTransient ? "Untitled group" : "—")}
                {isTransient && (
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    (unsaved)
                  </span>
                )}
              </p>
              <p className="text-muted-foreground text-xs">
                {group.members.length}{" "}
                {group.members.length === 1 ? "profile" : "profiles"}
              </p>
            </div>
            <ChevronDown className="text-muted-foreground size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[14rem]"
          data-testid="group-bar-menu"
        >
          {savedGroups.length > 0 && (
            <>
              {savedGroups.map((g) => (
                <DropdownMenuItem
                  key={g.id ?? g.name}
                  onSelect={() => onPick(g.id ?? "")}
                  data-testid={`group-bar-menu-item-${g.id ?? ""}`}
                >
                  {g.name}
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                    {g.members?.length ?? 0}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={onNew} data-testid="group-bar-new">
            <Plus className="size-3.5" />
            New group…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 text-xs"
        onClick={onManage}
        data-testid="group-bar-manage"
      >
        <Settings2 className="mr-1 size-3.5" />
        {isTransient ? "Save group" : "Manage"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 text-xs"
        onClick={onClear}
        data-testid="group-bar-clear"
      >
        <X className="mr-1 size-3.5" />
        Clear
      </Button>
    </div>
  );
}
