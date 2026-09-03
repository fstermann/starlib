"use client";

import {
  AlignVerticalSpaceAround,
  Check,
  CheckCircle2,
  Circle,
  CirclePause,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  deleteTrack,
  effectiveDurationInSet,
  formatTimecode,
  originalBpmFromSet,
  windowSupport,
  type TrackTimelineEntry,
} from "@/lib/analyser";
import { searchTracks, type SCTrack } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

import type { AnalyserUiState } from "../_state";
import { AddTrackDialog } from "./add-track-dialog";
import { AlignmentDialog } from "./alignment-dialog";
import { PreviewPopover, type PreviewSource } from "./preview-popover";
import { computeNextStarts, rowKeyOf } from "./row-keys";
import type { SetAudio } from "./set-waveform";

interface TracklistPanelProps {
  state: AnalyserUiState;
  audio: SetAudio;
  /** When set (changing nonce), scroll the matching row into view and
   *  flash a brief highlight. Driven by clicks on timeline track bands. */
  focusedTrack?: { key: string; nonce: number } | null;
  /** Track keys (``${start_s}-${shazam_id ?? title}``) the user has
   *  marked as correctly identified. */
  confirmed?: Set<string>;
  /** Toggle the confirmation flag for a track. Persisted to
   *  localStorage by the page-level state owner. */
  onToggleConfirmed?: (key: string) => void;
  /** Reload the snapshot — called after a manual add / hide / unhide so
   *  the merged tracklist reflects the new override. */
  onTracklistChanged?: () => void;
  /** Minimum number of agreeing scan windows a Shazam track needs before
   *  it's listed. 1 = show everything (single-window hits flagged
   *  tentative). Higher values hide weak/likely-generic matches. Manual
   *  and confirmed rows are always shown regardless. */
  minMatches?: number;
  onMinMatchesChange?: (n: number) => void;
}

/** Upper bound for the min-matches filter slider. */
const MAX_MIN_MATCHES = 4;

interface DerivedRun {
  start_s: number;
  end_s: number;
  title: string;
  artist: string | null;
  shazam_id: string | null;
  confidence: number;
}

function bestPerScanPoint(
  scans: AnalyserUiState["scans"],
): AnalyserUiState["scans"] {
  const byPoint = new Map<number, AnalyserUiState["scans"][number]>();
  for (const row of scans) {
    const existing = byPoint.get(row.scan_s);
    if (!existing) {
      byPoint.set(row.scan_s, row);
      continue;
    }
    const existingReal = existing.title != null;
    const rowReal = row.title != null;
    if (rowReal && !existingReal) byPoint.set(row.scan_s, row);
    else if (rowReal && existingReal && row.confidence > existing.confidence)
      byPoint.set(row.scan_s, row);
  }
  return [...byPoint.values()].sort((a, b) => a.scan_s - b.scan_s);
}

/** Same aggregation used by the timeline lane — keep in lock-step. */
function aggregateScans(scans: AnalyserUiState["scans"]): DerivedRun[] {
  const reduced = bestPerScanPoint(scans);
  const runs: DerivedRun[] = [];
  let open: DerivedRun | null = null;
  for (const s of reduced) {
    if (s.title == null) {
      if (open) {
        runs.push(open);
        open = null;
      }
      continue;
    }
    const key = s.shazam_id ?? `${s.title}|${s.artist ?? ""}`;
    const openKey =
      open && (open.shazam_id ?? `${open.title}|${open.artist ?? ""}`);
    if (open && openKey === key) {
      open.end_s = s.scan_s;
      open.confidence = Math.max(open.confidence, s.confidence);
    } else {
      if (open) runs.push(open);
      open = {
        start_s: s.scan_s,
        end_s: s.scan_s,
        title: s.title,
        artist: s.artist,
        shazam_id: s.shazam_id,
        confidence: s.confidence,
      };
    }
  }
  if (open) runs.push(open);
  return runs;
}

interface Alternative {
  title: string;
  artist: string | null;
  shazam_id: string | null;
  confidence: number;
  pitch_offset: number;
  matches: number;
}

/** Distinct alternative tracks matched within a run's [start, end] span,
 *  excluding the primary. Sorted by hit count then confidence. */
function alternativesForRun(
  run: {
    start_s: number;
    end_s: number;
    shazam_id: string | null;
    title: string;
    artist: string | null;
  },
  scans: AnalyserUiState["scans"],
): Alternative[] {
  const primaryKey = run.shazam_id ?? `${run.title}|${run.artist ?? ""}`;
  const byKey = new Map<string, Alternative>();
  for (const s of scans) {
    if (s.title == null) continue;
    if (s.scan_s < run.start_s - 1e-3 || s.scan_s > run.end_s + 1e-3) continue;
    const key = s.shazam_id ?? `${s.title}|${s.artist ?? ""}`;
    if (key === primaryKey) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.matches += 1;
      existing.confidence = Math.max(existing.confidence, s.confidence);
    } else {
      byKey.set(key, {
        title: s.title,
        artist: s.artist,
        shazam_id: s.shazam_id,
        confidence: s.confidence,
        pitch_offset: s.pitch_offset,
        matches: 1,
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.matches - a.matches || b.confidence - a.confidence,
  );
}

type FindState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "hit"; track: SCTrack }
  | { kind: "miss" }
  | { kind: "error"; message: string };

export function TracklistPanel({
  state,
  audio,
  focusedTrack,
  confirmed,
  onToggleConfirmed,
  onTracklistChanged,
  minMatches = 1,
  onMinMatchesChange,
}: TracklistPanelProps) {
  // Live runs while a scan is in flight; the backend's terminal
  // `track.timeline` overrides once it lands (same shape).
  const derived = useMemo(() => aggregateScans(state.scans), [state.scans]);
  const allTracks: (DerivedRun | TrackTimelineEntry)[] =
    state.timeline.length > 0 ? state.timeline : derived;

  const supportByShazamId = useMemo(
    () => windowSupport(state.scans),
    [state.scans],
  );

  // Apply the min-matches filter: hide Shazam tracks backed by fewer than
  // ``minMatches`` agreeing windows. Manual rows (no shazam_id) and rows
  // the user has confirmed are always kept — the filter only triages
  // unreviewed Shazam guesses.
  const tracks = useMemo(
    () =>
      minMatches <= 1
        ? allTracks
        : allTracks.filter((t) => {
            if (t.shazam_id == null) return true;
            if (confirmed?.has(rowKeyOf(t))) return true;
            return (supportByShazamId.get(t.shazam_id) ?? 0) >= minMatches;
          }),
    [allTracks, minMatches, supportByShazamId, confirmed],
  );
  const hiddenCount = allTracks.length - tracks.length;

  // Track open in the alignment dialog (null = closed). We hold the
  // entry rather than just an id so the dialog content stays stable
  // even if the parent tracklist re-renders mid-edit. ``soundcloudId``
  // captures a find-state hit when the row's stored ``soundcloud_id``
  // is null — otherwise the dialog would say "No SoundCloud match"
  // even though the user clearly resolved one.
  const [aligning, setAligning] = useState<{
    track: TrackTimelineEntry;
    soundcloudId: number | null;
  } | null>(null);

  // Build a lookup from track-identity key → Shazam preview metadata
  // (preview_url + artwork_url). The track.timeline events strip these
  // off so we recover them by walking the raw scan grid. Keyed by
  // ``shazam_id || title|artist`` to match alternative bookkeeping.
  const previewByKey = useMemo(() => {
    const m = new Map<
      string,
      { preview_url: string | null; artwork_url: string | null }
    >();
    for (const s of state.scans) {
      if (s.title == null) continue;
      const key = s.shazam_id ?? `${s.title}|${s.artist ?? ""}`;
      const cur = m.get(key);
      const preview_url = s.preview_url ?? null;
      const artwork_url = s.artwork_url ?? null;
      // Prefer the first non-null preview / artwork we see for a key.
      if (!cur) m.set(key, { preview_url, artwork_url });
      else
        m.set(key, {
          preview_url: cur.preview_url ?? preview_url,
          artwork_url: cur.artwork_url ?? artwork_url,
        });
    }
    return m;
  }, [state.scans]);

  // Per-row "find on SoundCloud" cache so re-clicking on an already-resolved
  // row plays instantly without a fresh /tracks search.
  // One in-section preview popover open at a time (Shazam clip or
  // SoundCloud stream). Keyed `${baseKey}:${kind}`.
  const [openPreview, setOpenPreview] = useState<string | null>(null);
  // Functional toggle: closing only clears the slot when this key is
  // still the active one, so a click that opens another preview (which
  // also fires the previous popover's outside-dismiss) doesn't race to
  // null and reopen-flicker.
  const togglePreview = (key: string, next: boolean) =>
    setOpenPreview((prev) => (next ? key : prev === key ? null : prev));
  const [findState, setFindState] = useState<Record<string, FindState>>({});
  const setFindFor = (key: string, value: FindState) =>
    setFindState((prev) => ({ ...prev, [key]: value }));

  // Refs to each row so a focus signal can scroll into view + briefly
  // flash a highlight. Map keyed by the same rowKey we render with.
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  // Per-row override: when the user picks an alternative, we display it
  // as the primary for that scan range. Frontend-only — the canonical
  // tracklist on the backend stays untouched, but this lets the user
  // audition a different match when Shazam picked the wrong one.
  const [chosenAlt, setChosenAlt] = useState<Record<string, Alternative>>({});
  const pickAlternative = (key: string, alt: Alternative) =>
    setChosenAlt((m) => ({ ...m, [key]: alt }));
  const resetAlternative = (key: string) =>
    setChosenAlt((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
  const [flashKey, setFlashKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusedTrack) return;
    const el = rowRefs.current.get(focusedTrack.key);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // Defer the highlight + clear to a microtask so the flash mount
    // happens outside this effect's synchronous body (lint rule
    // ``react-hooks/set-state-in-effect``).
    const onTick = setTimeout(() => setFlashKey(focusedTrack.key), 0);
    const offTick = setTimeout(() => setFlashKey(null), 1200);
    return () => {
      clearTimeout(onTick);
      clearTimeout(offTick);
    };
  }, [focusedTrack]);

  // Resolve a row/alt to a SoundCloud hit via search. Returns the hit
  // (or null) so callers can open the preview popover without racing the
  // async ``findState`` update.
  const resolveSc = async (
    key: string,
    track: { title: string; artist: string | null },
  ): Promise<SCTrack | null> => {
    const cached = findState[key];
    if (cached?.kind === "hit") return cached.track;
    if (cached?.kind === "loading") return null;
    setFindFor(key, { kind: "loading" });
    try {
      const query = track.artist
        ? `${track.title} ${track.artist}`
        : track.title;
      const results = await searchTracks(query, 3);
      if (results.length === 0) {
        setFindFor(key, { kind: "miss" });
        return null;
      }
      setFindFor(key, { kind: "hit", track: results[0] });
      return results[0];
    } catch (err) {
      setFindFor(key, {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  // Resolved SoundCloud preview props for a row/alt key: the audio
  // source, the open-in-SoundCloud link, and the urn the like button
  // acts on. All null until the row's search resolves to a hit.
  const scPreviewProps = (
    key: string,
  ): {
    source: PreviewSource;
    openUrl: string | null;
    likeUrn: string;
  } | null => {
    const st = findState[key];
    if (st?.kind !== "hit") return null;
    const id = scTrackId(st.track);
    if (id == null) return null;
    return {
      source: {
        kind: "soundcloud",
        trackId: id,
        waveformUrl: st.track.waveform_url ?? null,
        durationS: st.track.duration != null ? st.track.duration / 1000 : null,
      },
      openUrl: st.track.permalink_url ?? null,
      likeUrn: `soundcloud:tracks:${id}`,
    };
  };

  // Map each row to the start of the next row so the per-row Play
  // button reflects the global set transport: a row is "active"
  // whenever the set is playing AND the playhead sits between this
  // row's start and the next row's start. Using the per-row
  // ``[start_s, end_s]`` span instead would flip back to Play almost
  // immediately for single-scan-point runs (where ``end_s == start_s``).
  // Keyed by ``rowKeyOf`` — the SAME key the render loop uses. A
  // mismatch here makes every lookup miss, the fallback span becomes
  // infinite, and pressing set-play marks every row as active.
  const nextStarts = useMemo(() => computeNextStarts(tracks), [tracks]);

  const isRowActive = (rowKey: string, start: number) => {
    const next = nextStarts.get(rowKey) ?? Number.POSITIVE_INFINITY;
    return (
      audio.isPlaying &&
      audio.progressS + 1e-3 >= start &&
      audio.progressS < next
    );
  };

  const jumpToTrack = (start: number) => {
    audio.seek(start);
    audio.play();
  };

  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const handleRemoveTrack = async (
    rowKey: string,
    track: TrackTimelineEntry | DerivedRun,
  ) => {
    // Only real timeline entries (with an ``id``) are removable. The
    // ``DerivedRun`` fallback path is rendered live during the Shazam
    // scan before any ``analyser_tracks`` row exists yet — those are
    // ephemeral, no row to delete.
    if (!state.jobId || !onTracklistChanged || !("id" in track)) return;
    setRemovingKey(rowKey);
    try {
      await deleteTrack(state.jobId, track.id);
      onTracklistChanged();
    } catch (err) {
      console.warn("analyser: failed to remove track", err);
    } finally {
      setRemovingKey(null);
    }
  };

  return (
    <section
      className="border-border bg-surface-2 flex min-h-0 flex-1 flex-col gap-2 rounded-lg border px-4 py-3"
      data-testid="tracklist-panel"
    >
      <header className="bg-surface-2 -mx-4 -mt-3 flex items-center justify-between rounded-t-lg px-4 py-3">
        <h2 className="text-text text-sm font-semibold">
          Tracklist
          <span className="text-text-muted ml-2 text-xs font-normal">
            {tracks.length === 0
              ? "no matches yet"
              : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
            {hiddenCount > 0 && (
              <span className="text-text-subtle"> · {hiddenCount} hidden</span>
            )}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          {allTracks.length > 0 && onMinMatchesChange && (
            <label
              className="text-text-subtle flex items-center gap-1.5 text-xs"
              title="Hide tracks matched at fewer than this many scan windows. 1 shows everything (single-window hits flagged tentative)."
              data-testid="min-matches-control"
            >
              <span className="whitespace-nowrap">min matches</span>
              <Slider
                value={[minMatches]}
                min={1}
                max={MAX_MIN_MATCHES}
                step={1}
                onValueChange={(v) => onMinMatchesChange(v[0] ?? 1)}
                className="w-20"
                data-testid="min-matches-slider"
                aria-label="Minimum matches to show a track"
              />
              <span
                className="w-3 tabular-nums"
                data-testid="min-matches-value"
              >
                {minMatches}
              </span>
            </label>
          )}
          {tracks.length > 0 && confirmed && (
            <span
              className="text-text-muted text-xs tabular-nums"
              data-testid="confirmed-count"
            >
              <span className="text-brand font-semibold">
                {
                  tracks.filter((t) =>
                    confirmed.has(`${t.start_s}-${t.shazam_id ?? t.title}`),
                  ).length
                }
              </span>
              <span className="text-text-subtle"> / {tracks.length}</span>{" "}
              confirmed
            </span>
          )}
          {state.jobId && onTracklistChanged && (
            <AddTrackDialog
              jobId={state.jobId}
              defaultStartS={audio.progressS}
              onAdded={onTracklistChanged}
            />
          )}
        </div>
      </header>
      {tracks.length === 0 ? (
        <p className="text-text-subtle py-6 text-center text-xs italic">
          {state.scans.length > 0
            ? `scanning… ${state.scans.length} probe${state.scans.length === 1 ? "" : "s"} so far, no matches yet`
            : "Start a Shazam scan to identify tracks in this set."}
        </p>
      ) : (
        <ol
          className="divide-border -mx-4 min-h-0 flex-1 divide-y overflow-y-auto px-4 pb-6"
          data-testid="tracklist-rows"
        >
          {tracks.map((t) => {
            // Stable id-based key shared with the timeline. ``DerivedRun``
            // entries (live during the Shazam scan, before any
            // ``analyser_tracks`` row exists) fall back to the
            // start+title key — there's nothing to confirm/remove on
            // those yet anyway.
            const rowKey = rowKeyOf(t);
            const reactKey = rowKey;
            const isPlaying = isRowActive(rowKey, t.start_s);
            const find = findState[rowKey] ?? { kind: "idle" };
            const allAlts = alternativesForRun(
              {
                start_s: t.start_s,
                end_s: t.end_s,
                shazam_id: t.shazam_id,
                title: t.title,
                artist: t.artist,
              },
              state.scans,
            );
            // Apply user override: the chosen alternative replaces the
            // displayed primary; the original primary becomes available
            // in the alternatives list. Confidence/title/artist follow
            // whichever match is currently selected.
            const override = chosenAlt[rowKey];
            const display = override
              ? {
                  start_s: t.start_s,
                  end_s: t.end_s,
                  title: override.title,
                  artist: override.artist,
                  shazam_id: override.shazam_id,
                  confidence: override.confidence,
                }
              : t;
            const alts: Alternative[] = override
              ? [
                  {
                    title: t.title,
                    artist: t.artist,
                    shazam_id: t.shazam_id,
                    confidence: t.confidence,
                    pitch_offset: 0,
                    matches: 0,
                  },
                  ...allAlts.filter(
                    (a) =>
                      (a.shazam_id ?? `${a.title}|${a.artist ?? ""}`) !==
                      (override.shazam_id ??
                        `${override.title}|${override.artist ?? ""}`),
                  ),
                ]
              : allAlts;
            const isConfirmed = confirmed?.has(rowKey) ?? false;
            // Tentative = a Shazam match seen at < 2 windows and not yet
            // user-confirmed. Manual rows (no shazam_id) are never tentative.
            const isTentative =
              !isConfirmed &&
              display.shazam_id != null &&
              (supportByShazamId.get(display.shazam_id) ?? 0) < 2;
            const displayKey =
              display.shazam_id ?? `${display.title}|${display.artist ?? ""}`;
            const scArtwork =
              find.kind === "hit"
                ? ((find.track as { artwork_url?: string | null })
                    .artwork_url ?? null)
                : null;
            const artworkUrl =
              (override
                ? previewByKey.get(displayKey)?.artwork_url
                : (("artwork_url" in t ? t.artwork_url : null) ??
                  previewByKey.get(displayKey)?.artwork_url)) ?? scArtwork;
            return (
              <li
                key={reactKey}
                ref={(el) => {
                  if (el) rowRefs.current.set(rowKey, el);
                  else rowRefs.current.delete(rowKey);
                }}
                className={cn(
                  "group -mx-4 grid grid-cols-[64px_40px_1fr_auto] items-center gap-3 px-4 py-2 transition-colors",
                  isPlaying && "bg-brand-soft/40 rounded",
                  isTentative && "opacity-65",
                  flashKey === rowKey &&
                    "ring-brand/70 rounded ring-2 ring-inset",
                )}
                data-testid="tracklist-row"
                data-confirmed={isConfirmed ? "true" : "false"}
                data-tentative={isTentative ? "true" : "false"}
              >
                <span className="text-text-muted text-xs tabular-nums">
                  {formatTimecode(t.start_s)}
                </span>
                {artworkUrl ? (
                  <img
                    src={artworkUrl}
                    alt=""
                    aria-hidden="true"
                    className="bg-surface-3 size-10 rounded object-cover"
                    data-testid="tracklist-artwork"
                  />
                ) : (
                  <div
                    className="bg-surface-3 size-10 rounded"
                    data-testid="tracklist-artwork-fallback"
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0">
                  <div
                    className="text-text flex items-center gap-1.5 truncate text-sm font-medium"
                    title={display.title}
                  >
                    <span className="truncate">{display.title}</span>
                    {isTentative && (
                      <span
                        className="border-border text-text-subtle shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold tracking-wider uppercase"
                        title="Matched at only one probe — likely but unconfirmed. Run Refine or Pinpoint to corroborate."
                        data-testid="tracklist-tentative"
                      >
                        tentative
                      </span>
                    )}
                    {override && (
                      <span
                        className="bg-brand-soft text-text rounded px-1 py-0.5 text-[9px] font-semibold tracking-wider uppercase"
                        title="You picked this alternative; click the icon on the right to revert"
                      >
                        switched
                      </span>
                    )}
                    {"source" in t && t.source === "manual" && (
                      <span
                        className="bg-brand-soft text-text rounded px-1 py-0.5 text-[9px] font-semibold tracking-wider uppercase"
                        title="Added manually"
                      >
                        manual
                      </span>
                    )}
                  </div>
                  <div className="text-text-muted flex items-center gap-2 truncate text-xs">
                    {display.artist && (
                      <span title={display.artist}>{display.artist}</span>
                    )}
                    <BpmChip track={t} />
                    <DurationChip track={t} />
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {/* Confidence + curate cluster.

                      Layout (left → right):  [trash] [%] [circle/check]

                      - The circle/check is pinned to the right so the
                        primary curation affordance never moves.
                      - Trash collapses to width 0 at rest and slides in
                        on row hover; its widening pushes ``%`` (and any
                        siblings on its left) leftward — that's the "%
                        animates to left on hover" effect.
                      - On confirmed rows the % collapses too, leaving
                        only the green check at rest. Hovering re-expands
                        both ``%`` and trash with the same width+opacity
                        transition. */}
                  {/* Align button — surfaces the A/B alignment dialog.
                      Only meaningful for materialised tracklist rows
                      (DerivedRun entries don't have an id yet). Hidden
                      at rest, slides in on hover, same shape as trash. */}
                  {state.jobId && "id" in t && (
                    <div
                      className={cn(
                        "pointer-events-none flex max-w-0 items-center overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 ease-out",
                        "group-hover:pointer-events-auto group-hover:max-w-9 group-hover:opacity-100",
                      )}
                    >
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Align this track"
                        title="Align this track to the mix"
                        onClick={() => {
                          // Prefer the row's stored soundcloud_id; if the
                          // user used "find on SoundCloud" without
                          // persisting the result yet, fall back to the
                          // in-memory find-state hit so the dialog can
                          // still stream the correct original.
                          const entry = t as TrackTimelineEntry;
                          const stored = entry.soundcloud_id ?? null;
                          const fromFind =
                            find.kind === "hit" ? scTrackId(find.track) : null;
                          // Legacy track rows (pre set_bpm + pitch_offset
                          // columns) still have null in those fields;
                          // backfill from the live scan grid so the
                          // dialog can still pitch-match the original.
                          const filled =
                            entry.set_bpm == null || entry.pitch_offset == null
                              ? backfillBpmFromScans(entry, state.scans)
                              : entry;
                          setAligning({
                            track: filled,
                            soundcloudId: stored ?? fromFind ?? null,
                          });
                        }}
                        data-testid="align-track"
                        className="text-text-subtle hover:text-text"
                      >
                        <AlignVerticalSpaceAround className="size-4" />
                      </Button>
                    </div>
                  )}
                  {onTracklistChanged && (
                    <div
                      className={cn(
                        // ``pointer-events`` is flipped explicitly: with
                        // ``max-w-0 overflow-hidden`` alone, the button
                        // renders outside the wrapper's 0-width box, and
                        // some browsers route clicks on the clipped
                        // overflow to the wrong target. Disabling
                        // pointer events at rest and re-enabling on
                        // hover keeps the click target deterministic.
                        "pointer-events-none flex max-w-0 items-center overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 ease-out",
                        "group-hover:pointer-events-auto group-hover:max-w-9 group-hover:opacity-100",
                      )}
                    >
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Remove this track"
                        title="Remove this track"
                        onClick={() => void handleRemoveTrack(rowKey, t)}
                        disabled={removingKey === rowKey}
                        data-testid="remove-track"
                        data-track-source={
                          "source" in t ? (t.source ?? "shazam") : "shazam"
                        }
                        className="text-text-subtle hover:text-destructive"
                      >
                        {removingKey === rowKey ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  )}
                  <div
                    className={cn(
                      "flex items-center overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
                      isConfirmed
                        ? "max-w-0 opacity-0 group-hover:max-w-12 group-hover:opacity-100"
                        : "max-w-12 opacity-100",
                    )}
                  >
                    <span
                      className={cn(
                        "text-text-subtle px-1 text-[10px] tabular-nums",
                        display.confidence >= 0.9 && "text-brand",
                      )}
                      aria-label="confidence"
                    >
                      {Math.round(display.confidence * 100)}%
                    </span>
                  </div>
                  {onToggleConfirmed && (
                    <div
                      className={cn(
                        "flex items-center overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
                        // Confirmed: check is the rightmost at-rest badge.
                        // Unconfirmed: empty circle stays collapsed at rest
                        // and slides in on hover so idle rows don't show
                        // dangling empty affordances. Same pointer-events
                        // gating as the trash so the clipped overflow
                        // isn't a phantom click target at rest.
                        isConfirmed
                          ? "max-w-9 opacity-100"
                          : "pointer-events-none max-w-0 opacity-0 group-hover:pointer-events-auto group-hover:max-w-9 group-hover:opacity-100",
                      )}
                    >
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={
                          isConfirmed
                            ? "Mark as not yet checked"
                            : "Mark as correctly identified"
                        }
                        title={
                          isConfirmed
                            ? "Mark as not yet checked"
                            : "Mark as correctly identified"
                        }
                        onClick={() => onToggleConfirmed(rowKey)}
                        data-testid="toggle-confirmed"
                        data-confirmed={isConfirmed ? "true" : "false"}
                        className={cn(
                          "transition-colors",
                          isConfirmed && "text-brand",
                        )}
                      >
                        {isConfirmed ? (
                          <CheckCircle2 className="size-4" />
                        ) : (
                          <Circle className="size-4" />
                        )}
                      </Button>
                    </div>
                  )}
                  {override && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Revert to original Shazam pick"
                      title="Revert to original Shazam pick"
                      onClick={() => resetAlternative(rowKey)}
                      data-testid="revert-alternative"
                    >
                      <RotateCcw className="size-4" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant={isPlaying ? "default" : "ghost"}
                    aria-label={isPlaying ? "Pause" : "Jump to track in set"}
                    title={isPlaying ? "Pause" : "Jump to track in set"}
                    onClick={() =>
                      isPlaying ? audio.togglePlay() : jumpToTrack(t.start_s)
                    }
                    data-testid="play-section"
                    className="rounded-full"
                  >
                    {isPlaying ? (
                      <Pause className="size-4" />
                    ) : (
                      <Play className="size-4" />
                    )}
                  </Button>
                  {(() => {
                    const previewKey =
                      display.shazam_id ??
                      `${display.title}|${display.artist ?? ""}`;
                    const previewMeta = previewByKey.get(previewKey);
                    const previewUrl =
                      (override
                        ? null
                        : "preview_url" in t
                          ? t.preview_url
                          : null) ??
                      previewMeta?.preview_url ??
                      null;
                    if (!previewUrl) {
                      // No preview clip — keep the column slot filled with a
                      // disabled glyph so the button rows stay aligned.
                      return (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled
                          aria-label="No Shazam preview available"
                          title="No Shazam preview available"
                          data-testid="shazam-preview"
                          data-available="false"
                          className="opacity-30"
                        >
                          <ShazamGlyph className="size-4" />
                        </Button>
                      );
                    }
                    const popKey = `${rowKey}:shazam`;
                    const isOpen = openPreview === popKey;
                    return (
                      <PreviewPopover
                        open={isOpen}
                        onOpenChange={(o) => togglePreview(popKey, o)}
                        source={{ kind: "url", url: previewUrl }}
                        title={display.title}
                        subtitle={display.artist}
                        contentTestId="shazam-preview-popover"
                        openUrl={
                          display.shazam_id
                            ? shazamTrackUrl(display.shazam_id)
                            : null
                        }
                        openLabel="Open on Shazam"
                        openTestId="shazam-link"
                      >
                        <Button
                          type="button"
                          size="icon"
                          variant={isOpen ? "default" : "ghost"}
                          aria-label={
                            isOpen
                              ? "Close Shazam preview"
                              : "Play Shazam preview"
                          }
                          title={
                            isOpen
                              ? "Close Shazam preview"
                              : "Play Shazam preview"
                          }
                          data-testid="shazam-preview"
                        >
                          {isOpen ? (
                            <CirclePause className="size-4" />
                          ) : (
                            <ShazamGlyph className="size-4" />
                          )}
                        </Button>
                      </PreviewPopover>
                    );
                  })()}
                  {(() => {
                    const popKey = `${rowKey}:sc`;
                    const isOpen = openPreview === popKey;
                    const sc = isOpen ? scPreviewProps(rowKey) : null;
                    // A confirmed miss/error grays the button out — the icon
                    // now carries the "not found" state the inline text used
                    // to. Disabling it also makes it a non-opening slot so
                    // the column stays aligned.
                    const unavailable =
                      find.kind === "miss" || find.kind === "error";
                    return (
                      <PreviewPopover
                        open={isOpen}
                        onOpenChange={(o) => {
                          togglePreview(popKey, o);
                          // Resolve on open; if nothing's found, close again
                          // so the popover doesn't hang empty — the grayed
                          // button then reflects the miss.
                          if (o)
                            void resolveSc(rowKey, display).then((hit) => {
                              if (!hit) togglePreview(popKey, false);
                            });
                        }}
                        source={sc?.source ?? null}
                        title={display.title}
                        subtitle={display.artist}
                        contentTestId="soundcloud-preview-popover"
                        openUrl={sc?.openUrl ?? null}
                        openLabel="Open on SoundCloud"
                        openTestId="soundcloud-link"
                        likeUrn={sc?.likeUrn ?? null}
                      >
                        <Button
                          type="button"
                          size="icon"
                          variant={isOpen ? "default" : "ghost"}
                          aria-label={
                            unavailable
                              ? "Not found on SoundCloud"
                              : isOpen
                                ? "Close SoundCloud preview"
                                : "Find & play on SoundCloud"
                          }
                          title={
                            unavailable
                              ? find.kind === "error"
                                ? "SoundCloud lookup failed"
                                : "Not found on SoundCloud"
                              : isOpen
                                ? "Close SoundCloud preview"
                                : "Find & play on SoundCloud"
                          }
                          disabled={find.kind === "loading" || unavailable}
                          data-testid="find-soundcloud"
                          data-available={unavailable ? "false" : "true"}
                          className={cn(
                            "rounded-full",
                            unavailable && "opacity-30",
                          )}
                        >
                          {find.kind === "loading" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : isOpen ? (
                            <Pause className="size-4" />
                          ) : (
                            <SoundcloudGlyph className="size-4" />
                          )}
                        </Button>
                      </PreviewPopover>
                    );
                  })()}
                </div>
                {alts.length > 0 && (
                  <AlternativesList
                    alternatives={alts}
                    primaryStart={t.start_s}
                    onPick={(alt) => pickAlternative(rowKey, alt)}
                    findStateFor={(alt) =>
                      findState[
                        `${rowKey}::alt::${alt.shazam_id ?? alt.title}`
                      ] ?? { kind: "idle" }
                    }
                    previewByKey={previewByKey}
                    rowKey={rowKey}
                    openPreview={openPreview}
                    togglePreview={togglePreview}
                    onResolveSc={resolveSc}
                    scPreviewProps={scPreviewProps}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
      {state.jobId && aligning && (
        <AlignmentDialog
          open
          onOpenChange={(o) => {
            if (!o) setAligning(null);
          }}
          jobId={state.jobId}
          track={aligning.track}
          soundcloudIdOverride={aligning.soundcloudId}
          onSaved={() => {
            setAligning(null);
            onTracklistChanged?.();
          }}
        />
      )}
    </section>
  );
}

function AlternativesList({
  alternatives,
  primaryStart,
  onPick,
  findStateFor,
  previewByKey,
  rowKey,
  openPreview,
  togglePreview,
  onResolveSc,
  scPreviewProps,
}: {
  alternatives: Alternative[];
  primaryStart: number;
  onPick: (alt: Alternative) => void;
  findStateFor: (alt: Alternative) => FindState;
  previewByKey: Map<
    string,
    { preview_url: string | null; artwork_url: string | null }
  >;
  rowKey: string;
  openPreview: string | null;
  togglePreview: (key: string, next: boolean) => void;
  onResolveSc: (
    key: string,
    track: { title: string; artist: string | null },
  ) => Promise<SCTrack | null>;
  scPreviewProps: (key: string) => {
    source: PreviewSource;
    openUrl: string | null;
    likeUrn: string;
  } | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="col-span-4 -mt-1 ml-[116px]"
      data-testid="track-alternatives"
      data-row-start={primaryStart}
    >
      <button
        type="button"
        className="text-text-subtle hover:text-text-muted text-[11px]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "Hide" : "Show"} {alternatives.length} alternative
        {alternatives.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {alternatives.map((a) => {
            const altKey = a.shazam_id ?? `${a.title}|${a.artist ?? ""}`;
            const fullKey = `${rowKey}::alt::${altKey}`;
            const find = findStateFor(a);
            const previewMeta = previewByKey.get(altKey);
            const previewUrl = previewMeta?.preview_url ?? null;
            const shazamPopKey = `${fullKey}:shazam`;
            const scPopKey = `${fullKey}:sc`;
            const shazamOpen = openPreview === shazamPopKey;
            const scOpen = openPreview === scPopKey;
            const scAlt = scOpen ? scPreviewProps(fullKey) : null;
            const scUnavailable = find.kind === "miss" || find.kind === "error";
            return (
              <li
                key={altKey}
                className="text-text-muted flex items-center gap-2 py-0.5"
                data-testid="track-alternative"
              >
                <span className="text-text-subtle w-6 shrink-0 text-[10px] tabular-nums">
                  ×{a.matches}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-text">{a.title}</span>
                  {a.artist && (
                    <span className="text-text-muted"> — {a.artist}</span>
                  )}
                </span>
                <span className="text-text-subtle text-[10px] tabular-nums">
                  {Math.round(a.confidence * 100)}%
                </span>
                <button
                  type="button"
                  className="text-text-subtle hover:text-brand grid size-5 place-items-center rounded transition-colors"
                  aria-label="Make this the picked match"
                  title="Make this the picked match"
                  onClick={() => onPick(a)}
                  data-testid="pick-alternative"
                >
                  <Check className="size-3" />
                </button>
                {previewUrl ? (
                  <PreviewPopover
                    open={shazamOpen}
                    onOpenChange={(o) => togglePreview(shazamPopKey, o)}
                    source={{ kind: "url", url: previewUrl }}
                    title={a.title}
                    subtitle={a.artist}
                    contentTestId="shazam-preview-popover"
                    openUrl={a.shazam_id ? shazamTrackUrl(a.shazam_id) : null}
                    openLabel="Open on Shazam"
                    openTestId="shazam-link"
                  >
                    <button
                      type="button"
                      className="text-text-subtle hover:text-text grid size-5 place-items-center rounded transition-colors"
                      aria-label={
                        shazamOpen
                          ? "Close Shazam preview"
                          : "Play Shazam preview"
                      }
                      title={
                        shazamOpen
                          ? "Close Shazam preview"
                          : "Play Shazam preview"
                      }
                      data-testid="shazam-preview-alternative"
                    >
                      {shazamOpen ? (
                        <CirclePause className="size-3" />
                      ) : (
                        <ShazamGlyph className="size-3" />
                      )}
                    </button>
                  </PreviewPopover>
                ) : (
                  <span
                    className="text-text-subtle grid size-5 place-items-center opacity-30"
                    aria-label="No Shazam preview available"
                    title="No Shazam preview available"
                    data-testid="shazam-preview-alternative"
                    data-available="false"
                  >
                    <ShazamGlyph className="size-3" />
                  </span>
                )}
                <PreviewPopover
                  open={scOpen}
                  onOpenChange={(o) => {
                    togglePreview(scPopKey, o);
                    if (o)
                      void onResolveSc(fullKey, a).then((hit) => {
                        if (!hit) togglePreview(scPopKey, false);
                      });
                  }}
                  source={scAlt?.source ?? null}
                  title={a.title}
                  subtitle={a.artist}
                  contentTestId="soundcloud-preview-popover"
                  openUrl={scAlt?.openUrl ?? null}
                  openLabel="Open on SoundCloud"
                  openTestId="soundcloud-link"
                  likeUrn={scAlt?.likeUrn ?? null}
                >
                  <button
                    type="button"
                    className={cn(
                      "text-text-subtle hover:text-text grid size-5 place-items-center rounded transition-colors",
                      scUnavailable && "opacity-30",
                    )}
                    aria-label={
                      scUnavailable
                        ? "Not found on SoundCloud"
                        : "Find & play on SoundCloud"
                    }
                    title={
                      scUnavailable
                        ? find.kind === "error"
                          ? "SoundCloud lookup failed"
                          : "Not found on SoundCloud"
                        : "Find & play on SoundCloud"
                    }
                    disabled={find.kind === "loading" || scUnavailable}
                    data-testid="find-soundcloud-alternative"
                    data-available={scUnavailable ? "false" : "true"}
                  >
                    {find.kind === "loading" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <SoundcloudGlyph className="size-3" />
                    )}
                  </button>
                </PreviewPopover>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Pull set_bpm + pitch_offset from the live scan grid for a Shazam-
 *  matched track row that was inserted before those columns existed
 *  (or by a sync that didn't carry them through yet). Picks the
 *  highest-confidence scan matching the row's shazam_id; pitch_offset
 *  comes from that scan, set_bpm is left ``null`` and the dialog falls
 *  back to native tempo when it can't be derived. */
function backfillBpmFromScans(
  track: TrackTimelineEntry,
  scans: AnalyserUiState["scans"],
): TrackTimelineEntry {
  if (!track.shazam_id) return track;
  let best: AnalyserUiState["scans"][number] | null = null;
  for (const s of scans) {
    if (s.shazam_id !== track.shazam_id || s.title == null) continue;
    if (best == null || s.confidence > best.confidence) best = s;
  }
  if (best == null) return track;
  return {
    ...track,
    pitch_offset: track.pitch_offset ?? best.pitch_offset ?? null,
  };
}

function shazamTrackUrl(shazamId: string): string {
  return `https://www.shazam.com/track/${encodeURIComponent(shazamId)}`;
}

function scTrackId(track: SCTrack): number | null {
  // SoundCloud has been migrating to URN-only ids on /tracks responses; the
  // numeric id is still present on most payloads but not all. Falling back
  // to parsing the trailing integer of `urn` keeps us robust to either.
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

/** Brand-mark icon backed by an SVG asset in ``frontend/public/icons``.
 *  ``invert`` flips fill colour with ``currentColor`` so the glyphs read
 *  on either theme — the SVGs are solid black, so we negate them in
 *  dark mode the same way the WaveformPlayer does. */
function BrandIcon({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt={alt}
      className={cn("dark:invert", className)}
      aria-hidden="true"
    />
  );
}

function SoundcloudGlyph({ className }: { className?: string }) {
  return <BrandIcon src="/icons/soundcloud.svg" alt="" className={className} />;
}

function ShazamGlyph({ className }: { className?: string }) {
  return <BrandIcon src="/icons/shazam.svg" alt="" className={className} />;
}

/** ``128 → 124 BPM`` chip. Hidden for derived/manual rows that don't
 *  carry the persisted scan stats; hidden when no pitch shift was
 *  applied (offset 0 means "set BPM == original BPM" so the arrow form
 *  is just visual noise). */
function BpmChip({ track }: { track: TrackTimelineEntry | DerivedRun }) {
  if (!("set_bpm" in track)) return null;
  const setBpm = track.set_bpm;
  const offset = track.pitch_offset;
  if (setBpm == null) return null;
  const original = originalBpmFromSet(setBpm, offset);
  const showArrow = original != null && Math.abs(setBpm - original) >= 0.5;
  return (
    <span
      className="text-text-subtle tabular-nums"
      data-testid="tracklist-bpm"
      title={
        showArrow
          ? `Set ${setBpm.toFixed(1)} BPM, original ${original?.toFixed(1)} BPM (pitch ${offset?.toFixed(2)} ST)`
          : `${setBpm.toFixed(1)} BPM`
      }
    >
      {showArrow
        ? `${setBpm.toFixed(0)} → ${original?.toFixed(0)} BPM`
        : `${setBpm.toFixed(0)} BPM`}
    </span>
  );
}

/** Effective length of the track *as it plays in the set* — original
 *  duration scaled by the pitch ratio. Hidden when we don't know the
 *  original duration. */
function DurationChip({ track }: { track: TrackTimelineEntry | DerivedRun }) {
  if (!("duration_s" in track) || !("pitch_offset" in track)) return null;
  const inSet = effectiveDurationInSet(track.duration_s, track.pitch_offset);
  if (inSet == null) return null;
  return (
    <span
      className="text-text-subtle tabular-nums"
      data-testid="tracklist-effective-duration"
      title={
        track.pitch_offset != null && track.pitch_offset !== 0
          ? `Plays as ${formatTimecode(inSet)} in the set (original ${track.duration_s != null ? formatTimecode(track.duration_s) : "—"})`
          : `Track length ${formatTimecode(inSet)}`
      }
    >
      {formatTimecode(inSet)}
    </span>
  );
}
