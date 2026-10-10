"use client";

import { FileAudio } from "lucide-react";
import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface Match {
  file_path: string;
  file_name: string;
  title?: string | null;
  artist?: string | string[] | null;
}

function artistText(artist: Match["artist"]): string | null {
  if (!artist) return null;
  return Array.isArray(artist) ? artist.join(", ") : artist;
}

const MIN_QUERY = 2;

/** Search the local collection and pick a track to break down. */
export function TrackPicker({ onPick }: { onPick: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .browseFiles(
          "collection",
          { search: trimmed, size: 12 },
          controller.signal,
        )
        .then((page) => setMatches((page.items ?? []) as Match[]))
        .catch(() => {
          if (!controller.signal.aborted) setMatches([]);
        });
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl text-[var(--text)]">Track Breakdown</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Pick a track from your collection to see its sections, play its stems
          and study how builds, drops and breakdowns are put together. You can
          also right-click a track in the library and choose Open in Breakdown.
        </p>
      </div>
      <Input
        autoFocus
        placeholder="Search your collection"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="track-picker-input"
      />
      <ul className="flex flex-col">
        {(query.trim().length >= MIN_QUERY ? matches : []).map((m) => (
          <li key={m.file_path}>
            <button
              type="button"
              onClick={() => onPick(m.file_path)}
              className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-[var(--surface-3)]"
              data-testid="track-picker-result"
            >
              <FileAudio className="size-4 shrink-0 text-[var(--text-muted)]" />
              <span className="truncate text-sm text-[var(--text)]">
                {m.title ?? m.file_name}
              </span>
              {artistText(m.artist) && (
                <span className="truncate text-sm text-[var(--text-muted)]">
                  {artistText(m.artist)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
