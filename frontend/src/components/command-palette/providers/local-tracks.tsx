"use client";

import { FileAudio } from "lucide-react";
import { useMemo } from "react";

import type { CommandProvider } from "@/components/command-palette/types";
import { api } from "@/lib/api";

import { useRegisterProvider } from "../use-register-provider";

type TrackMatch = {
  file_path: string;
  title?: string | null;
  artist?: string | string[] | null;
  folder?: string | null;
  file_name: string;
};

function joinArtist(artist?: string | string[] | null): string | undefined {
  if (!artist) return undefined;
  return Array.isArray(artist) ? artist.filter(Boolean).join(", ") : artist;
}

/** Async provider: search the local collection (title/artist). */
export function LocalTracksProvider({
  onSelect,
}: {
  onSelect: (track: TrackMatch) => void;
}) {
  const provider = useMemo<CommandProvider>(
    () => ({
      id: "local-tracks",
      order: 20,
      mode: "async",
      minQueryLength: 2,
      provide: async (query, signal) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const page = await api.browseFiles(
          "collection",
          { search: trimmed, size: 8 },
          signal,
        );
        if (signal.aborted) return [];
        const items = page.items ?? [];
        const results = [];
        for (const track of items as TrackMatch[]) {
          const artist = joinArtist(track.artist);
          results.push({
            id: `local:${track.file_path}`,
            label: track.title ?? track.file_name,
            description: artist ?? track.folder ?? undefined,
            icon: FileAudio,
            group: "Local Library",
            run: ({ close }: { close: () => void }) => {
              onSelect(track);
              close();
            },
          });
        }
        return results;
      },
    }),
    [onSelect],
  );

  useRegisterProvider(provider);
  return null;
}
