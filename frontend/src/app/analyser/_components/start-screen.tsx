"use client";

import { Trash2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  deleteJob,
  formatTimecode,
  listRecentJobs,
  type JobSummary,
} from "@/lib/analyser";
import { searchSets, type SCTrack } from "@/lib/soundcloud";

/** Tracks shorter than this are filtered out of the set search — a DJ
 *  set is rarely under 20 minutes, single tracks rarely over. */
const MIN_SET_DURATION_MS = 20 * 60 * 1000;

interface StartScreenProps {
  onStart: (input: { url: string }) => Promise<void>;
  onOpen: (jobId: string) => void;
  initialUrl?: string;
  errorMessage?: string | null;
}

/** Number of "confirmed" track keys stored in localStorage for a job.
 *  Mirrors the page-level confirmed-set; reading directly here keeps the
 *  recent-list a self-contained component instead of hoisting state. */
function readConfirmedCount(jobId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(`analyser:confirmed:${jobId}`);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function AnalyserStartScreen({
  onStart,
  onOpen,
  initialUrl = "",
  errorMessage = null,
}: StartScreenProps) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<JobSummary[]>([]);
  const [results, setResults] = useState<SCTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const isUrl = /^https?:\/\//i.test(url.trim());

  // Non-URL input doubles as a set search: debounce, then query
  // SoundCloud with a minimum-duration filter so only sets show up.
  useEffect(() => {
    const q = url.trim();
    if (isUrl || q.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchSets(q, MIN_SET_DURATION_MS)
        .then((hits) => {
          if (cancelled) return;
          setResults(hits);
          setSearchError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setSearchError(
            "Search failed — make sure you are signed in to SoundCloud.",
          );
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [url, isUrl]);

  const loadRecent = () =>
    listRecentJobs()
      .then((res) => setRecent(res.jobs))
      .catch(() => setRecent([]));

  useEffect(() => {
    void loadRecent();
  }, []);

  const submit = async () => {
    if (!isUrl || busy) return;
    setBusy(true);
    try {
      await onStart({ url: url.trim() });
    } finally {
      setBusy(false);
    }
  };

  const startFromResult = async (t: SCTrack) => {
    if (!t.permalink_url || busy) return;
    setBusy(true);
    try {
      await onStart({ url: t.permalink_url });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (jobId: string) => {
    try {
      await deleteJob(jobId);
      // Also wipe the confirmed-set for this job — otherwise a future
      // job that happens to reuse the same id (won't happen with uuid4
      // in practice, but cheap to be tidy) would inherit ghost marks.
      try {
        window.localStorage.removeItem(`analyser:confirmed:${jobId}`);
      } catch {
        // private mode / disabled storage — fine
      }
      await loadRecent();
    } catch (err) {
      console.warn("analyser: failed to delete job", err);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="analyser-start-screen">
      <section className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border p-6">
        <h1 className="text-text text-xl font-semibold">Set Analyser</h1>
        <p className="text-text-muted text-sm">
          Paste a SoundCloud URL or search for a set — Starlib downloads it,
          streams BPM windows, detects section boundaries, and identifies tracks
          via Shazam.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="analyser-url">SoundCloud URL or search</Label>
          <div className="flex gap-2">
            <Input
              id="analyser-url"
              data-testid="analyser-url-input"
              autoComplete="off"
              placeholder="https://soundcloud.com/dj/example-set — or search…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <Button
              onClick={submit}
              disabled={!isUrl || busy}
              data-testid="analyser-start-button"
            >
              {busy ? "Starting…" : "Analyse"}
            </Button>
          </div>
          {errorMessage && (
            <p className="text-destructive text-xs">{errorMessage}</p>
          )}
          {searchError && (
            <p
              className="text-destructive text-xs"
              data-testid="set-search-error"
            >
              {searchError}
            </p>
          )}
          {!isUrl && url.trim().length >= 2 && !searchError && (
            <div data-testid="set-search-results">
              <p className="text-text-subtle text-xs">
                {searching && results.length === 0
                  ? "Searching…"
                  : `Sets longer than ${MIN_SET_DURATION_MS / 60000} min`}
              </p>
              <ul className="divide-border divide-y">
                {results.map((t) => (
                  <li key={t.urn ?? t.permalink_url}>
                    <button
                      type="button"
                      className="hover:bg-surface-3 flex w-full items-center gap-3 rounded-md px-1 py-2 text-left"
                      onClick={() => void startFromResult(t)}
                      disabled={busy}
                      data-testid="set-search-result"
                    >
                      {t.artwork_url ? (
                        <img
                          src={t.artwork_url}
                          alt=""
                          aria-hidden="true"
                          className="size-9 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="bg-surface-3 size-9 shrink-0 rounded" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="text-text block truncate text-sm font-medium">
                          {t.title}
                        </span>
                        <span className="text-text-muted block truncate text-xs">
                          {t.user?.username ?? "—"}
                        </span>
                      </span>
                      <span className="text-text-subtle shrink-0 text-xs tabular-nums">
                        {t.duration ? formatTimecode(t.duration / 1000) : "—"}
                      </span>
                    </button>
                  </li>
                ))}
                {!searching && results.length === 0 && (
                  <li className="text-text-muted py-2 text-xs">
                    No sets found.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </section>
      {recent.length > 0 && (
        <section className="border-border bg-surface-2 rounded-lg border p-4">
          <h2 className="text-text mb-2 flex items-center justify-between text-sm font-semibold">
            <span>Recent analyses</span>
            <span className="text-text-subtle text-xs font-normal tabular-nums">
              {recent.length}
            </span>
          </h2>
          <ul className="divide-border divide-y" data-testid="recent-jobs">
            {recent.map((j) => {
              const confirmed = readConfirmedCount(j.id);
              return (
                <li
                  key={j.id}
                  className="flex items-center justify-between gap-3 py-2"
                  data-testid="recent-job"
                  data-job-id={j.id}
                >
                  <button
                    type="button"
                    className="text-text hover:text-brand min-w-0 flex-1 text-left"
                    onClick={() => onOpen(j.id)}
                  >
                    <div className="truncate font-medium">
                      {j.title ?? "(untitled)"}
                    </div>
                    <div className="text-text-muted truncate text-xs">
                      {j.artist ?? "—"} ·{" "}
                      {j.duration_s ? formatTimecode(j.duration_s) : "—"} ·{" "}
                      {j.status}
                    </div>
                  </button>
                  <div
                    className="text-text-subtle flex shrink-0 items-center gap-3 text-xs tabular-nums"
                    data-testid="recent-job-stats"
                  >
                    <span title="Tracks in tracklist">
                      <span className="text-text font-medium">
                        {j.track_count}
                      </span>{" "}
                      tracks
                    </span>
                    {j.track_count > 0 && (
                      <span title="Marked as correctly identified">
                        <span className="text-brand font-medium">
                          {confirmed}
                        </span>
                        <span className="text-text-subtle">
                          /{j.track_count}
                        </span>{" "}
                        ok
                      </span>
                    )}
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Delete analysis"
                        title="Delete analysis"
                        className="text-text-subtle hover:text-destructive"
                        data-testid="delete-job"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent data-testid="delete-job-dialog">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete analysis?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {`"${j.title ?? "(untitled)"}" and every BPM window, section, Shazam match and tracklist edit will be removed. Cannot be undone.`}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => void handleDelete(j.id)}
                          data-testid="delete-job-confirm"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
