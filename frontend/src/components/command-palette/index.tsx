"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem as CommandItemUI,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

import { useCommandPalette } from "./provider";
import { LocalTracksProvider } from "./providers/local-tracks";
import { NavProvider } from "./providers/nav";
import { PinnedFoldersProvider } from "./providers/pinned-folders";
import { SoundcloudTracksProvider } from "./providers/soundcloud-tracks";
import { SoundcloudUsersProvider } from "./providers/soundcloud-users";
import type { CommandItem, CommandProvider } from "./types";

const ASYNC_DEBOUNCE_MS = 300;

function groupBy(items: CommandItem[]): Map<string, CommandItem[]> {
  const map = new Map<string, CommandItem[]>();
  for (const item of items) {
    const list = map.get(item.group);
    if (list) list.push(item);
    else map.set(item.group, [item]);
  }
  return map;
}

export function CommandPalette() {
  const { open, setOpen, providers, dynamicCommands } = useCommandPalette();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [asyncResults, setAsyncResults] = useState<CommandItem[]>([]);
  const [pending, setPending] = useState(0);

  // Keep the live query accessible to stable onSelect callbacks without
  // adding `query` to their deps (which would invalidate them every keystroke
  // and thrash provider memos).
  const queryRef = useRef("");
  queryRef.current = query;

  // Stable handlers for built-in providers — inline arrows would thrash their memos.
  const onNavigate = useCallback((href: string) => router.push(href), [router]);
  const onSelectTrack = useCallback(
    (track: { permalink_url?: string | null; urn?: string | null }) => {
      const urn = track.urn;
      // Jump to the Search tab with the USER'S palette query (not the track URL)
      // so results show the full list they saw in the palette. `play=<urn>`
      // tells SoundcloudView to autoplay the matching row.
      const userQuery = queryRef.current.trim() || track.permalink_url || "";
      if (!userQuery) return;
      const params = new URLSearchParams({
        source: "soundcloud",
        tab: "search",
        q: userQuery,
      });
      if (urn) params.set("play", urn);
      router.push(`/library?${params.toString()}`);
    },
    [router],
  );
  const onSelectUser = useCallback(
    (user: { permalink?: string | null } | null | undefined) => {
      const permalink = user?.permalink;
      if (permalink) {
        router.push(
          `/library?source=soundcloud&tab=discover&u=${encodeURIComponent(permalink)}`,
        );
      }
    },
    [router],
  );

  const onSelectLocalTrack = useCallback(
    (track: { folder?: string | null; file_path: string }) => {
      const params = new URLSearchParams({ source: "filesystem" });
      if (track.folder) params.set("nodeId", track.folder);
      const userQuery = queryRef.current.trim();
      if (userQuery) params.set("search", userQuery);
      params.set("play", track.file_path);
      router.push(`/library?${params.toString()}`);
    },
    [router],
  );

  const onSelectPinnedFolder = useCallback(
    (absPath: string) => {
      const params = new URLSearchParams({ source: "filesystem" });
      if (absPath) params.set("nodeId", absPath);
      router.push(`/library?${params.toString()}`);
    },
    [router],
  );

  // Reset state when closed so next open is clean.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setAsyncResults([]);
      setPending(0);
    }
  }, [open]);

  // Run async providers on query change.
  useEffect(() => {
    if (!open) return;
    const asyncProviders = providers.filter((p) => p.mode === "async");
    if (asyncProviders.length === 0) {
      setAsyncResults([]);
      return;
    }
    const controller = new AbortController();
    const minLen = Math.max(
      ...asyncProviders.map((p) => p.minQueryLength ?? 2),
      0,
    );
    const trimmed = query.trim();
    if (trimmed.length < minLen) {
      setAsyncResults([]);
      setPending(0);
      return;
    }

    const timeout = setTimeout(async () => {
      setPending(asyncProviders.length);
      const nextResults: CommandItem[] = [];
      await Promise.all(
        asyncProviders.map(async (p) => {
          try {
            const items = await p.provide(query, controller.signal);
            if (controller.signal.aborted) return;
            nextResults.push(...items);
          } catch {
            // Swallow per-provider errors; don't break the palette.
          } finally {
            if (!controller.signal.aborted) {
              setPending((n) => Math.max(0, n - 1));
            }
          }
        }),
      );
      if (!controller.signal.aborted) setAsyncResults(nextResults);
    }, ASYNC_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, open, providers]);

  // Run sync providers every render (cheap — static arrays).
  const allSyncItems = useMemo(() => {
    const items: CommandItem[] = [];
    for (const p of providers) {
      if (p.mode !== "sync") continue;
      try {
        const result = p.provide("", new AbortController().signal);
        if (Array.isArray(result)) items.push(...result);
      } catch {
        // ignore
      }
    }
    return items;
  }, [providers]);

  function matches(item: CommandItem, q: string): boolean {
    if (!q) return true;
    const hay = [item.label, item.description, ...(item.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .every((tok) => hay.includes(tok));
  }

  const syncItems = useMemo(
    () => allSyncItems.filter((i) => matches(i, query)),
    [allSyncItems, query],
  );
  const filteredDynamic = useMemo(
    () => dynamicCommands.filter((i) => matches(i, query)),
    [dynamicCommands, query],
  );

  const close = useCallback(() => setOpen(false), [setOpen]);

  const runItem = useCallback(
    (item: CommandItem) => {
      void item.run({ close, query });
    },
    [close, query],
  );

  // Group ordering: sort groups by first-seen provider order, dynamic commands get their own fixed slot.
  const groupOrder = useMemo(() => {
    const order = new Map<string, number>();
    const sortedProviders: CommandProvider[] = [...providers].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
    let i = 0;
    for (const p of sortedProviders) {
      try {
        const res =
          p.mode === "sync"
            ? (p.provide("", new AbortController().signal) as CommandItem[])
            : [];
        for (const item of res) {
          if (!order.has(item.group)) order.set(item.group, i++);
        }
      } catch {
        // ignore
      }
    }
    // Actions (from dynamic) pinned near top if not seen yet.
    if (!order.has("Actions")) order.set("Actions", -1);
    return order;
  }, [providers]);

  const dynamicGroups = useMemo(
    () => groupBy(filteredDynamic),
    [filteredDynamic],
  );
  const syncGroups = useMemo(() => groupBy(syncItems), [syncItems]);
  const asyncGroups = useMemo(() => groupBy(asyncResults), [asyncResults]);

  const allGroupNames = useMemo(() => {
    const names = new Set<string>([
      ...dynamicGroups.keys(),
      ...syncGroups.keys(),
      ...asyncGroups.keys(),
    ]);
    return [...names].sort((a, b) => {
      const av = groupOrder.get(a) ?? 999;
      const bv = groupOrder.get(b) ?? 999;
      if (av !== bv) return av - bv;
      return a.localeCompare(b);
    });
  }, [dynamicGroups, syncGroups, asyncGroups, groupOrder]);

  const hasAny =
    filteredDynamic.length > 0 ||
    syncItems.length > 0 ||
    asyncResults.length > 0;

  return (
    <>
      {/* Built-in providers — mount inside the context so they register. */}
      <NavProvider onNavigate={onNavigate} />
      <PinnedFoldersProvider onSelect={onSelectPinnedFolder} />
      <LocalTracksProvider onSelect={onSelectLocalTrack} />
      <SoundcloudTracksProvider onSelect={onSelectTrack} />
      <SoundcloudUsersProvider onSelect={onSelectUser} />

      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search or type a command…"
        />
        <CommandList>
          {!hasAny && pending === 0 && <CommandEmpty>No results.</CommandEmpty>}
          {pending > 0 && (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
              <Loader2 className="size-3 animate-spin" />
              Searching…
            </div>
          )}
          {allGroupNames.map((group) => {
            const items: CommandItem[] = [
              ...(dynamicGroups.get(group) ?? []),
              ...(syncGroups.get(group) ?? []),
              ...(asyncGroups.get(group) ?? []),
            ];
            if (items.length === 0) return null;
            return (
              <CommandGroup key={group} heading={group}>
                {items.map((item) => {
                  const Icon = item.icon;
                  const value = [
                    item.label,
                    item.description,
                    ...(item.keywords ?? []),
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <CommandItemUI
                      key={item.id}
                      data-command-id={item.id}
                      data-command-group={item.group}
                      value={`${item.id} ${value}`}
                      onSelect={() => runItem(item)}
                    >
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="size-4 shrink-0 rounded object-cover"
                        />
                      ) : Icon ? (
                        <Icon className="text-muted-foreground size-4 shrink-0" />
                      ) : null}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.label}</span>
                        {item.description && (
                          <span className="text-muted-foreground truncate text-xs">
                            {item.description}
                          </span>
                        )}
                      </div>
                      {item.shortcut && (
                        <CommandShortcut>
                          {item.shortcut.join("")}
                        </CommandShortcut>
                      )}
                    </CommandItemUI>
                  );
                })}
              </CommandGroup>
            );
          })}
        </CommandList>
      </CommandDialog>
    </>
  );
}

export { useCommand } from "./use-command";
export { useCommandPalette, CommandPaletteProvider } from "./provider";
export { CommandPaletteTrigger } from "./search-trigger";
