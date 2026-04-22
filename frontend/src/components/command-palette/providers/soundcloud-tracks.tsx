"use client";

import { Music } from "lucide-react";
import { useMemo } from "react";

import type { CommandProvider } from "@/components/command-palette/types";
import { api } from "@/lib/api";
import { resolveUrl, searchTracks, type SCTrack } from "@/lib/soundcloud";

import { useRegisterProvider } from "../use-register-provider";

const TRACK_URL_RE = /^https?:\/\/(www\.)?soundcloud\.com\//i;

export function SoundcloudTracksProvider({
  onSelect,
}: {
  onSelect: (track: SCTrack) => void;
}) {
  const provider = useMemo<CommandProvider>(
    () => ({
      id: "sc-tracks",
      order: 30,
      mode: "async",
      minQueryLength: 2,
      provide: async (query, signal) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        let tracks: SCTrack[] = [];
        if (TRACK_URL_RE.test(trimmed)) {
          const resolved = await resolveUrl(trimmed);
          if (signal.aborted) return [];
          if (resolved && "title" in resolved) tracks = [resolved as SCTrack];
        } else {
          tracks = await searchTracks(trimmed, 10);
          if (signal.aborted) return [];
        }
        const validTracks = tracks.filter((t): t is SCTrack => t != null);
        return validTracks.map((t) => ({
          id: `sc-track:${t.urn ?? t.permalink_url ?? t.title}`,
          label: t.title ?? "Untitled",
          description: t.user?.username,
          imageUrl: t.artwork_url
            ? api.proxyImageUrl(t.artwork_url)
            : undefined,
          icon: Music,
          group: "SoundCloud Tracks",
          run: ({ close }) => {
            onSelect(t);
            close();
          },
        }));
      },
    }),
    [onSelect],
  );

  useRegisterProvider(provider);
  return null;
}
