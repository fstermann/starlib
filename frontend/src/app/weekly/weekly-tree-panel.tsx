"use client";

import { CalendarDays, CheckCircle2, ListMusic } from "lucide-react";
import { useMemo } from "react";

import type { WeekGroup } from "@/app/weekly/use-weekly-groups";
import { TreeView } from "@/components/tree/tree-view";

export const WEEKS_GROUP_ID = "weeks";
export const ORPHANS_GROUP_ID = "orphans";
export const weekNodeId = (key: string) => `week:${key}`;
export const orphanNodeId = (key: string) => `orphan:${key}`;

type Kind = "root" | "group" | "week" | "orphan";

export interface WeeklyTreeNode {
  id: string;
  name: string;
  children: WeeklyTreeNode[];
  kind: Kind;
  trackCount?: number;
  isCurrent?: boolean;
  hasPlaylist?: boolean;
  newCount?: number;
}

export interface WeekEntry {
  group: WeekGroup;
  hasPlaylist: boolean;
  newCount: number;
  /** Filtered feed-track count for this week (respects the filter bar). */
  trackCount: number;
}

export interface OrphanEntry {
  key: string;
  title: string;
  trackCount: number;
  newCount: number;
}

function prettifyName(s: string): string {
  // Drop the "Weekly Favorites" prefix — we're already on that page.
  return s.replace(/^\s*weekly favorites\s*/i, "").trim() || s;
}

interface WeeklyTreePanelProps {
  weeks: WeekEntry[];
  orphans: OrphanEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function WeeklyTreePanel({
  weeks,
  orphans,
  selectedId,
  onSelect,
}: WeeklyTreePanelProps) {
  const tree = useMemo<WeeklyTreeNode>(() => {
    const weekNodes: WeeklyTreeNode[] = weeks.map(
      ({ group, hasPlaylist, newCount, trackCount }) => ({
        id: weekNodeId(group.key),
        name: prettifyName(group.label),
        children: [],
        kind: "week",
        trackCount,
        isCurrent: group.isCurrent,
        hasPlaylist,
        newCount,
      }),
    );

    const children: WeeklyTreeNode[] = [
      {
        id: WEEKS_GROUP_ID,
        name: "Active Weeks",
        children: weekNodes,
        kind: "group",
      },
    ];

    if (orphans.length > 0) {
      const totalOrphanTracks = orphans.reduce(
        (sum, o) => sum + o.trackCount,
        0,
      );
      const totalOrphanNew = orphans.reduce((sum, o) => sum + o.newCount, 0);
      children.push({
        id: ORPHANS_GROUP_ID,
        name: "Past Weeks",
        kind: "group",
        trackCount: totalOrphanTracks,
        newCount: totalOrphanNew,
        children: orphans.map((o) => ({
          id: orphanNodeId(o.key),
          name: prettifyName(o.title) || "Untitled",
          children: [],
          kind: "orphan",
          trackCount: o.trackCount,
          hasPlaylist: true,
          newCount: o.newCount,
        })),
      });
    }

    return {
      id: "root",
      name: "Weekly",
      children,
      kind: "root",
    };
  }, [weeks, orphans]);

  return (
    <TreeView<WeeklyTreeNode>
      tree={tree}
      selectedId={selectedId}
      onSelect={onSelect}
      storageKey="weekly"
      hideRoot
      renderIcon={(node) => {
        if (node.kind === "week") {
          return (
            <CalendarDays
              className={
                node.isCurrent
                  ? "text-primary size-3.5 shrink-0"
                  : "text-muted-foreground size-3.5 shrink-0"
              }
            />
          );
        }
        if (node.kind === "orphan") {
          return (
            <ListMusic className="text-muted-foreground size-3.5 shrink-0" />
          );
        }
        return null;
      }}
      renderBadge={(node) => {
        const badges: React.ReactNode[] = [];
        if (node.newCount && node.newCount > 0) {
          badges.push(
            <span
              key="new"
              className="text-success shrink-0 text-xs font-medium tabular-nums"
            >
              +{node.newCount}
            </span>,
          );
        }
        if (node.hasPlaylist) {
          badges.push(
            <CheckCircle2
              key="exists"
              className="text-success size-3 shrink-0"
            />,
          );
        }
        if (typeof node.trackCount === "number" && node.trackCount > 0) {
          badges.push(
            <span
              key="count"
              className="text-muted-foreground shrink-0 text-xs tabular-nums"
            >
              {node.trackCount}
            </span>,
          );
        }
        return badges.length > 0 ? <>{badges}</> : null;
      }}
    />
  );
}
