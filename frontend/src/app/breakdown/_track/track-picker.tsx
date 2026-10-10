"use client";

import { FileAudio, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  deleteTrackBreakdown,
  listRecentTracks,
  type RecentTrack,
} from "@/lib/track-breakdown";

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

export function fileStem(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Search the local collection and pick a track to break down. */
export function TrackPicker({ onPick }: { onPick: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [recent, setRecent] = useState<RecentTrack[]>([]);

  const loadRecent = () =>
    listRecentTracks()
      .then(setRecent)
      .catch(() => setRecent([]));

  useEffect(() => {
    void loadRecent();
  }, []);

  const remove = async (digest: string) => {
    await deleteTrackBreakdown(digest);
    await loadRecent();
  };

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
      {query.trim().length < MIN_QUERY && recent.length > 0 && (
        <RecentTracks tracks={recent} onPick={onPick} onDelete={remove} />
      )}
    </main>
  );
}

function RecentTracks({
  tracks,
  onPick,
  onDelete,
}: {
  tracks: RecentTrack[];
  onPick: (path: string) => void;
  onDelete: (digest: string) => Promise<void>;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="px-3 text-xs font-medium text-[var(--text-muted)]">
        Recent
      </h2>
      <ul className="flex flex-col" data-testid="recent-tracks">
        {tracks.map((t) => (
          <li
            key={t.digest}
            className="flex items-center gap-1"
            data-testid="recent-track"
          >
            <button
              type="button"
              disabled={t.missing}
              onClick={() => onPick(t.path)}
              title={t.missing ? `File not found: ${t.path}` : t.path}
              className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-left enabled:hover:bg-[var(--surface-3)] disabled:opacity-50"
            >
              <FileAudio className="size-4 shrink-0 text-[var(--text-muted)]" />
              <span className="truncate text-sm text-[var(--text)]">
                {fileStem(t.path)}
              </span>
              <span className="ml-auto shrink-0 text-xs text-[var(--text-subtle)] tabular-nums">
                {t.missing
                  ? "File not found"
                  : [
                      `${Math.round(t.bpm * 100) / 100} BPM`,
                      t.root,
                      `${t.n_bars} bars`,
                      formatDuration(t.duration_s),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
            </button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Delete breakdown"
                  title="Delete breakdown"
                  className="shrink-0 text-[var(--text-subtle)] hover:text-[var(--danger)]"
                  data-testid="delete-recent-track"
                >
                  <Trash2 className="size-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete breakdown?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {`The stems, measurements and section edits for "${fileStem(t.path)}" will be removed. The audio file stays.`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void onDelete(t.digest)}
                    data-testid="delete-recent-track-confirm"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </li>
        ))}
      </ul>
    </section>
  );
}
