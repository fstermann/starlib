"use client";

import { Loader2, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addTrack, formatTimecode } from "@/lib/analyser";
import { searchTracks, type SCTrack } from "@/lib/soundcloud";

interface AddTrackDialogProps {
  jobId: string;
  /** Current playhead in the set, used as the default start time. */
  defaultStartS: number;
  onAdded: () => void;
}

function scTrackId(track: SCTrack): number | null {
  const direct = (track as { id?: number | string }).id;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string" && /^\d+$/.test(direct)) return Number(direct);
  const urn = track.urn;
  if (typeof urn === "string") {
    const tail = urn.split(":").pop();
    if (tail && /^\d+$/.test(tail)) return Number(tail);
  }
  return null;
}

/** Parse "mm:ss" or "h:mm:ss" or a bare number of seconds. */
function parseTimecode(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

export function AddTrackDialog({
  jobId,
  defaultStartS,
  onAdded,
}: AddTrackDialogProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SCTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<SCTrack | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [start, setStart] = useState(formatTimecode(defaultStartS));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Bumped each time the dialog opens to throw away any stale debounce
  // result that comes back after the user has typed something new.
  const queryTokenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setStart(formatTimecode(defaultStartS));
    setQuery("");
    setResults([]);
    setPicked(null);
    setTitle("");
    setArtist("");
    setSubmitError(null);
    setSearchError(null);
  }, [open, defaultStartS]);

  useEffect(() => {
    if (!open) return;
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const token = ++queryTokenRef.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchTracks(query.trim(), 8)
        .then((hits) => {
          if (queryTokenRef.current !== token) return;
          setResults(hits);
          setSearchError(null);
        })
        .catch((err: unknown) => {
          if (queryTokenRef.current !== token) return;
          setSearchError(err instanceof Error ? err.message : String(err));
          setResults([]);
        })
        .finally(() => {
          if (queryTokenRef.current === token) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query, open]);

  const pickResult = (track: SCTrack) => {
    setPicked(track);
    if (track.title) setTitle(track.title);
    const userName = track.user?.username;
    if (userName) setArtist(userName);
  };

  const handleSubmit = async () => {
    setSubmitError(null);
    const startS = parseTimecode(start);
    if (startS == null || startS < 0) {
      setSubmitError("Start time must be mm:ss or seconds.");
      return;
    }
    if (!title.trim()) {
      setSubmitError("Title is required.");
      return;
    }
    setSubmitting(true);
    try {
      // SoundCloud reports ``duration`` in milliseconds; persist as
      // seconds so the timeline can render manual bands at their true
      // length instead of the next-track-start fallback.
      const durMs = picked?.duration;
      const durationS =
        typeof durMs === "number" && durMs > 0 ? durMs / 1000 : null;
      await addTrack(jobId, {
        start_s: startS,
        title: title.trim(),
        artist: artist.trim() || null,
        soundcloud_id: picked ? scTrackId(picked) : null,
        soundcloud_permalink_url: picked?.permalink_url ?? null,
        artwork_url: picked?.artwork_url ?? null,
        duration_s: durationS,
      });
      onAdded();
      setOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-text-muted hover:text-text gap-1.5"
          data-testid="add-track-trigger"
        >
          <Plus className="size-4" />
          Add track
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="add-track-dialog">
        <DialogHeader>
          <DialogTitle>Add track</DialogTitle>
          <DialogDescription>
            Search SoundCloud and link a track, or fill the fields manually.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-track-search">SoundCloud search</Label>
            <div className="relative">
              <Search className="text-text-subtle pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
              <Input
                id="add-track-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="title, artist…"
                className="pl-8"
                data-testid="add-track-search"
              />
              {searching && (
                <Loader2 className="text-text-subtle absolute top-1/2 right-2 size-4 -translate-y-1/2 animate-spin" />
              )}
            </div>
            {searchError && (
              <p className="text-destructive text-xs">{searchError}</p>
            )}
            {results.length > 0 && (
              <ul
                className="border-border bg-surface-1 max-h-48 overflow-y-auto rounded border"
                data-testid="add-track-results"
              >
                {results.map((r) => {
                  const id = scTrackId(r);
                  const isPicked =
                    picked != null && id != null && id === scTrackId(picked);
                  return (
                    <li key={r.urn ?? String(id)}>
                      <button
                        type="button"
                        onClick={() => pickResult(r)}
                        data-testid="add-track-result"
                        data-picked={isPicked ? "true" : "false"}
                        className={`hover:bg-surface-2 flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs ${
                          isPicked ? "bg-brand-soft/40" : ""
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-text font-medium">
                            {r.title}
                          </span>
                          {r.user?.username && (
                            <span className="text-text-muted">
                              {" "}
                              — {r.user.username}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-track-title">Title</Label>
              <Input
                id="add-track-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="add-track-title"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-track-artist">Artist</Label>
              <Input
                id="add-track-artist"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                data-testid="add-track-artist"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-track-start">Start time (mm:ss)</Label>
            <Input
              id="add-track-start"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              data-testid="add-track-start"
            />
          </div>

          {submitError && (
            <p className="text-destructive text-xs" data-testid="add-track-error">
              {submitError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            data-testid="add-track-submit"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Add track"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
