"use client";

import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatTimecode, type TrackTimelineEntry } from "@/lib/analyser";
import { searchTracks } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

import type { AnalyserUiState } from "../_state";
import {
  SetAudioCurrentTime,
  SetAudioPlayButton,
  type SetAudio,
} from "./set-waveform";

/** Module-level cache for SoundCloud artwork lookups keyed by Shazam id
 *  (or title|artist when no shazam_id). Persists across job navigations
 *  in the same session — re-opening a job re-uses everything we already
 *  fetched. ``null`` means we tried and got nothing (don't refetch). */
const ARTWORK_CACHE = new Map<string, string | null>();

function trackKey(t: {
  shazam_id: string | null;
  title: string;
  artist: string | null;
}): string {
  return t.shazam_id ?? `${t.title}|${t.artist ?? ""}`;
}

/** Best-effort artwork lookup for each identified track via SoundCloud
 *  search. Fires one search per unique track key (deduped against the
 *  module cache and against in-flight requests), and updates a piece
 *  of React state with the resolved URLs so the bands re-render
 *  individually as artwork lands. Silently degrades to ``null`` when
 *  the SC API is unauthenticated or the search misses. */
const ARTWORK_INFLIGHT = new Set<string>();
function useTrackArtworks(
  tracks: Array<{
    shazam_id: string | null;
    title: string;
    artist: string | null;
  }>,
): Map<string, string | null> {
  // Identity-stable key set for the dependency check — when this string
  // doesn't change, the effect doesn't refire, so a flurry of scan
  // events that produce the same (or smaller) track set won't trigger
  // re-fetches.
  const keysSig = tracks.map(trackKey).sort().join("|");

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const pending = tracks.filter((t) => {
      const k = trackKey(t);
      return !ARTWORK_CACHE.has(k) && !ARTWORK_INFLIGHT.has(k);
    });
    if (pending.length === 0) return;
    for (const t of pending) ARTWORK_INFLIGHT.add(trackKey(t));
    (async () => {
      await Promise.all(
        pending.map(async (t) => {
          const k = trackKey(t);
          try {
            const q = `${t.title} ${t.artist ?? ""}`.trim();
            if (!q) {
              ARTWORK_CACHE.set(k, null);
              return;
            }
            const hits = await searchTracks(q, 1);
            ARTWORK_CACHE.set(k, hits[0]?.artwork_url ?? null);
          } catch {
            ARTWORK_CACHE.set(k, null);
          } finally {
            ARTWORK_INFLIGHT.delete(k);
          }
        }),
      );
      if (!cancelled) setVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
    // ``keysSig`` captures the relevant identity of ``tracks`` — using
    // it instead of ``tracks`` itself avoids re-firing this effect when
    // the parent re-renders without actually adding new tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig]);

  // Build the consumer view from the cache on every render. ``version``
  // is read so that resolving a search re-runs this without needing
  // ``tracks`` reference to change.
  void version;
  const view = new Map<string, string | null>();
  for (const t of tracks) {
    const k = trackKey(t);
    if (ARTWORK_CACHE.has(k)) view.set(k, ARTWORK_CACHE.get(k) ?? null);
  }
  return view;
}

interface TimelineProps {
  state: AnalyserUiState;
  audio: SetAudio;
  onSelectRange: (start_s: number, end_s: number) => void;
  /** Fired when the user clicks an identified-track band on the
   *  timeline. The page wires this to the tracklist so the matching
   *  row scrolls into view + flashes briefly. */
  onFocusTrack?: (trackKey: string) => void;
  /** Track keys (``${start_s}-${shazam_id ?? title}``) the user has
   *  marked as correctly identified. Confirmed bands render with a
   *  small checkmark badge so the timeline reflects the same review
   *  state as the tracklist below. */
  confirmed?: Set<string>;
  /** Drag-edit handler: the page receives the original track + the
   *  newly-dragged bounds, decides whether to PATCH a manual override
   *  or convert a Shazam run via hide + add manually. */
  onEditBounds?: (
    track: DerivedRun,
    bounds: { start_s: number | null; end_s: number | null },
  ) => void;
}

const ROW_HEIGHTS = {
  bpm: 120,
  waveform: 56,
  axis: 18,
  tracks: 28,
} as const;

/** Vertical inset (px) the BPM chart leaves at the top of its band so
 *  the topmost y-axis label has breathing room from the card edge. The
 *  tracks lane (= bottom inset) is sized to roughly match this so the
 *  card looks vertically balanced when no tracks have been identified
 *  yet. Kept slightly larger than ROW_HEIGHTS.tracks because the BPM
 *  chips inside the BPM band steal a few px from the visible top gap. */
const BPM_PAD_TOP = 24;

const TOTAL_HEIGHT =
  ROW_HEIGHTS.bpm +
  ROW_HEIGHTS.waveform +
  ROW_HEIGHTS.axis +
  ROW_HEIGHTS.tracks;

/** Width (px) of the fixed left rail that holds the BPM y-axis labels
 *  and the audio transport. Sized to fit a 32-px round play button +
 *  small padding, balanced with RIGHT_RAIL so the chart sits visually
 *  centred in the card. */
const LEFT_RAIL = 48;

/** Width (px) of the fixed right rail that holds the total-duration
 *  label. Equal to LEFT_RAIL so every lane (BPM curve, waveform,
 *  time-axis ticks, track bands) shares the same horizontal extent and
 *  the chart reads as visually centred. */
const RIGHT_RAIL = 48;

export function AnalyserTimeline({
  state,
  audio,
  onSelectRange,
  onFocusTrack,
  confirmed,
  onEditBounds,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  // Unified hover state — set when the cursor is over the BPM or
  // waveform lane. Drives a single vertical guide line + tooltip pill
  // (timecode + nearest BPM) that spans both lanes, so the two read as
  // one chart.
  const [hover, setHover] = useState<{ x: number; w: number } | null>(null);
  const hoverX = hover?.x ?? null;
  const hoverW = hover?.w ?? null;

  const duration = state.meta.durationS || 1;

  const bpmExtent = useMemo(() => {
    const values = state.windows.map((w) => w.bpm).filter((b) => b > 0);
    if (values.length === 0) return [60, 180] as const;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = Math.max(2, (hi - lo) * 0.15);
    return [Math.max(0, lo - pad), hi + pad] as const;
  }, [state.windows]);

  function pxToSeconds(px: number, width: number): number {
    return Math.max(
      0,
      Math.min(duration, (px / Math.max(1, width)) * duration),
    );
  }

  // Audio playhead — vertical line spanning all lanes, positioned by the
  // waveform's progress relative to the analysed-set duration. Anchored
  // to the timeline's percentage axis so it lines up with section/track
  // bands automatically.
  const playheadLeft =
    audio.duration > 0
      ? (audio.progressS / audio.duration) * 100
      : null;

  // Hover-derived values: the time and nearest-BPM at the hovered X. We
  // compute these in the parent so a single tooltip + guide line can
  // span the BPM and waveform lanes (their hover regions feed the same
  // ``hoverX`` state).
  const hoverTime =
    hoverX != null && hoverW != null
      ? (hoverX / Math.max(1, hoverW)) * duration
      : null;
  const hoverBpm =
    hoverTime != null ? bpmAtTime(state.windows, hoverTime) : null;
  const combinedHoverHeight = ROW_HEIGHTS.bpm + ROW_HEIGHTS.waveform;

  return (
    <div
      ref={containerRef}
      // ``sticky top-0`` keeps the timeline (BPM curve, waveform,
      // playback controls) pinned to the top of the scroll container
      // so the user can scrub + read context while scrolling through
      // the tracklist below. ``z-20`` floats it above sibling rows
      // (track bands, detail pane, tracklist rows). ``isolate``
      // creates a new stacking context so backdrop-blur chips inside
      // (BPM run labels, hover tooltip) don't bleed through to
      // siblings scrolling underneath.
      className="border-border bg-surface-2 sticky top-0 z-20 isolate w-full shrink-0 overflow-hidden rounded-xl border"
      style={{ height: TOTAL_HEIGHT }}
      data-testid="analyser-timeline"
    >
      {/* Left rail: y-axis labels in the BPM band, play button in the
          waveform band, current-time readout in the time-axis band so
          it sits on the same line as the timecode ticks (10:00, 20:00…).
          Everything centred on the rail's vertical axis. */}
      <div
        className="absolute top-0 bottom-0 left-0 z-10"
        style={{ width: LEFT_RAIL }}
      >
        <BpmAxisLabels bpmExtent={bpmExtent} />
        <div
          className="absolute right-0 left-0"
          style={{
            top: ROW_HEIGHTS.bpm,
            height: ROW_HEIGHTS.waveform,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="set-audio-transport-rail"
        >
          <SetAudioPlayButton audio={audio} />
        </div>
        <div
          className="absolute right-0 left-0"
          style={{
            top: ROW_HEIGHTS.bpm + ROW_HEIGHTS.waveform,
            height: ROW_HEIGHTS.axis,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <SetAudioCurrentTime audio={audio} />
        </div>
      </div>

      {/* Right rail: total-duration label sits in the time-axis band so
          [current time, end time, axis ticks] all live on the same
          horizontal line — bookending the waveform with consistent
          baseline. */}
      <div
        className="absolute top-0 right-0 bottom-0 z-10"
        style={{ width: RIGHT_RAIL }}
      >
        <div
          className="text-text-subtle pointer-events-none absolute right-0 left-0 grid place-items-center text-[10px] tabular-nums"
          style={{
            top: ROW_HEIGHTS.bpm + ROW_HEIGHTS.waveform,
            height: ROW_HEIGHTS.axis,
          }}
          data-testid="set-audio-end-time"
        >
          {formatTimecode(audio.duration)}
        </div>
      </div>

      {/* Chart area — drag-to-select, hover guide, and percent-positioned
          lane content all live here so the rails above are unaffected. */}
      <div
        className="absolute top-0 bottom-0 overflow-hidden"
        style={{ left: LEFT_RAIL, right: RIGHT_RAIL }}
        onPointerDown={(e) => {
          const rect = (
            e.currentTarget as HTMLDivElement
          ).getBoundingClientRect();
          setDrag({
            x0: e.clientX - rect.left,
            x1: e.clientX - rect.left,
          });
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const rect = (
            e.currentTarget as HTMLDivElement
          ).getBoundingClientRect();
          setDrag({ ...drag, x1: e.clientX - rect.left });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const rect = (
            e.currentTarget as HTMLDivElement
          ).getBoundingClientRect();
          const a = pxToSeconds(Math.min(drag.x0, drag.x1), rect.width);
          const b = pxToSeconds(Math.max(drag.x0, drag.x1), rect.width);
          if (b - a > 0.5) onSelectRange(a, b);
          setDrag(null);
        }}
      >
        <BpmLane
          windows={state.windows}
          duration={duration}
          bpmExtent={bpmExtent}
          onHover={(x, w) => setHover({ x, w })}
          onLeave={() => setHover(null)}
        />
        <WaveformLane
          audio={audio}
          onHover={(x, w) => setHover({ x, w })}
          onLeave={() => setHover(null)}
        />
        <TimeAxisLane duration={duration} />
        <TracksLane
          scans={state.scans}
          timeline={state.timeline}
          duration={duration}
          selection={state.selection}
          onFocusTrack={onFocusTrack}
          confirmed={confirmed}
          onEditBounds={onEditBounds}
        />

        {/* Audio playhead spanning all lanes. */}
        {playheadLeft != null && (
          <div
            className="bg-brand pointer-events-none absolute top-0 bottom-0 z-10 w-px opacity-80"
            style={{ left: `${playheadLeft}%` }}
            data-testid="set-playhead"
          />
        )}

        {/* Unified hover guide + tooltip — driven by hover on either the
            BPM or waveform lane, so the two lanes read as one chart. */}
        {hoverX != null && hoverTime != null && (
          <>
            <div
              className="bg-text-subtle/60 pointer-events-none absolute top-0 z-20 w-px"
              style={{ left: hoverX, height: combinedHoverHeight }}
              data-testid="hover-guide"
            />
            <div
              className="border-border bg-surface-3/95 text-text pointer-events-none absolute z-30 rounded border px-2 py-1 text-[11px] whitespace-nowrap shadow-md backdrop-blur-sm"
              style={{
                left: hoverX,
                top: 4,
                transform: `translateX(${
                  hoverW != null && hoverX > hoverW - 80
                    ? "-100%"
                    : hoverX < 80
                      ? "0%"
                      : "-50%"
                })`,
              }}
              data-testid="hover-tooltip"
            >
              <span className="text-text-muted tabular-nums">
                {formatTimecode(hoverTime)}
              </span>
              {hoverBpm != null && (
                <span className="text-brand ml-2 font-semibold tabular-nums">
                  {hoverBpm.toFixed(1)} BPM
                </span>
              )}
            </div>
          </>
        )}

        {drag && (
          <div
            className="bg-brand/15 border-brand/50 pointer-events-none absolute top-0 bottom-0 z-10 border"
            style={{
              left: Math.min(drag.x0, drag.x1),
              width: Math.abs(drag.x1 - drag.x0),
            }}
          />
        )}
        {state.selection && !drag && (
          <SelectionMarker
            selection={state.selection}
            duration={duration}
            totalHeight={TOTAL_HEIGHT}
          />
        )}
      </div>
    </div>
  );
}

/** Y-axis BPM labels for the BPM lane, rendered in the left rail
 *  outside the chart area. Five evenly-spaced ticks (incl. min/max) so
 *  the user can read the absolute BPM at any height of the curve. */
function BpmAxisLabels({ bpmExtent }: { bpmExtent: readonly [number, number] }) {
  const [lo, hi] = bpmExtent;
  const range = Math.max(1, hi - lo);
  const H = 100; // matches the BpmLane SVG viewBox height
  // viewBox-space padTop chosen so the top label sits BPM_PAD_TOP px
  // from the card edge in DOM units (mirrors the bottom tracks lane).
  const padTop = (BPM_PAD_TOP / ROW_HEIGHTS.bpm) * H;
  const padBottom = 6;
  const labels = Array.from({ length: 5 }, (_, i) => {
    const ratio = i / 4;
    const bpm = hi - ratio * range;
    const yPct = ((padTop + ratio * (H - padTop - padBottom)) / H) * 100;
    return { bpm, yPct };
  });
  return (
    <div
      className="pointer-events-none absolute top-0 right-0 left-0"
      style={{ height: ROW_HEIGHTS.bpm }}
    >
      {labels.map((g) => (
        <span
          key={`y-${g.yPct}`}
          className="text-text-subtle absolute right-0 left-0 -translate-y-1/2 text-center text-[10px] tabular-nums"
          style={{ top: `${g.yPct}%` }}
        >
          {Math.round(g.bpm)}
        </span>
      ))}
    </div>
  );
}

/** Find the BPM value at an arbitrary timestamp by locating the window
 *  whose ``[start_s, end_s]`` interval contains it. Falls back to the
 *  closest window's BPM when ``t`` lands in a gap (rare, but possible
 *  when scans don't tile densely). Returns ``null`` only when there are
 *  no analysed windows at all. */
function bpmAtTime(
  windows: AnalyserUiState["windows"],
  t: number,
): number | null {
  if (windows.length === 0) return null;
  let bestGap = Infinity;
  let bestBpm: number | null = null;
  for (const w of windows) {
    if (t >= w.start_s && t <= w.end_s) return w.bpm;
    const gap = t < w.start_s ? w.start_s - t : t - w.end_s;
    if (gap < bestGap) {
      bestGap = gap;
      bestBpm = w.bpm;
    }
  }
  return bestBpm;
}

/** Minimum consecutive matching-rounded-BPM windows before a run is
 *  worth labelling. Below this we just leave the curve alone. */
const BPM_RUN_MIN_WINDOWS = 10;
/** Rolling-average half-window for the per-window smoothing pass. */
const BPM_RUN_SMOOTH_HALF = 2;

interface BpmRun {
  bpm: number;
  startTime: number;
  endTime: number;
}

/** Group consecutive smoothed/rounded-equal BPM windows into runs.
 *
 * Sliding average over ``2 * BPM_RUN_SMOOTH_HALF + 1`` windows knocks
 * out the per-window jitter, then we round to integer BPM and treat
 * each plateau (≥ ``BPM_RUN_MIN_WINDOWS`` consecutive equal values) as
 * a "BPM section" worth a chip-style label. Drop runs from the
 * segmentation pass — those track timbre, not tempo.
 */
function computeBpmRuns(windows: AnalyserUiState["windows"]): BpmRun[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.start_s - b.start_s);
  const rounded: number[] = sorted.map((_, i) => {
    const lo = Math.max(0, i - BPM_RUN_SMOOTH_HALF);
    const hi = Math.min(sorted.length, i + BPM_RUN_SMOOTH_HALF + 1);
    const slice = sorted
      .slice(lo, hi)
      .map((w) => w.bpm)
      .filter((b) => b > 0);
    if (slice.length === 0) return NaN;
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    return Math.round(avg);
  });

  const runs: BpmRun[] = [];
  let runStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const breaking =
      i === sorted.length ||
      Number.isNaN(rounded[i]) ||
      rounded[i] !== rounded[runStart];
    if (!breaking) continue;
    const runLen = i - runStart;
    const bpm = rounded[runStart];
    if (runLen >= BPM_RUN_MIN_WINDOWS && !Number.isNaN(bpm)) {
      runs.push({
        bpm,
        startTime: sorted[runStart].start_s,
        endTime: sorted[i - 1].end_s,
      });
    }
    // Skip past any NaN markers when restarting.
    while (i < sorted.length && Number.isNaN(rounded[i])) i++;
    runStart = i;
  }
  return runs;
}

function BpmLane({
  windows,
  duration,
  bpmExtent,
  onHover,
  onLeave,
}: {
  windows: AnalyserUiState["windows"];
  duration: number;
  bpmExtent: readonly [number, number];
  onHover: (x: number, w: number) => void;
  onLeave: () => void;
}) {
  const [lo, hi] = bpmExtent;
  const range = Math.max(1, hi - lo);
  const W = 1000;
  const H = 100;
  const padTop = (BPM_PAD_TOP / ROW_HEIGHTS.bpm) * H;
  const padBottom = 6;
  const plotH = H - padTop - padBottom;

  const sorted = useMemo(
    () => [...windows].sort((a, b) => a.start_s - b.start_s),
    [windows],
  );
  const points = useMemo(
    () =>
      sorted.map((w) => {
        const x = ((w.start_s + w.end_s) / 2 / Math.max(1, duration)) * W;
        const y = padTop + ((hi - w.bpm) / range) * plotH;
        return { x, y, w };
      }),
    [sorted, duration, hi, range, padTop, plotH],
  );
  const linePath = points.length
    ? points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
        )
        .join(" ")
    : "";
  const areaPath = points.length
    ? `M ${points[0].x.toFixed(2)} ${(H - padBottom).toFixed(2)} ` +
      points.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ") +
      ` L ${points[points.length - 1].x.toFixed(2)} ${(H - padBottom).toFixed(2)} Z`
    : "";

  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const ratio = i / 4;
    const bpm = hi - ratio * range;
    const y = padTop + ratio * plotH;
    return { y, bpm };
  });

  const bpmRuns = useMemo(() => computeBpmRuns(windows), [windows]);

  return (
    <div
      className="relative overflow-hidden"
      style={{ height: ROW_HEIGHTS.bpm }}
      data-testid="bpm-lane"
      onPointerMove={(e) => {
        const rect = (
          e.currentTarget as HTMLDivElement
        ).getBoundingClientRect();
        onHover(e.clientX - rect.left, rect.width);
      }}
      onPointerLeave={onLeave}
    >
      <svg
        className="absolute inset-0"
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        viewBox={`0 0 ${W} ${H}`}
      >
        <defs>
          <linearGradient id="bpm-area-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {gridLines.map((g) => (
          <line
            key={`grid-${g.y}`}
            x1={0}
            x2={W}
            y1={g.y}
            y2={g.y}
            stroke="var(--color-border)"
            strokeWidth={1}
            opacity={0.4}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {areaPath && <path d={areaPath} fill="url(#bpm-area-fade)" />}
        {linePath && (
          <path
            d={linePath}
            stroke="var(--color-brand)"
            strokeWidth={1.6}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {points.map((p, i) => (
          <circle
            key={`${p.w.start_s}-${i}`}
            cx={p.x}
            cy={p.y}
            r={2}
            fill={
              p.w.confidence === "high"
                ? "var(--color-brand)"
                : p.w.confidence === "medium"
                  ? "var(--color-text-muted)"
                  : "var(--color-text-subtle)"
            }
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-0">
        {bpmRuns.map((run) => {
          const midpoint = (run.startTime + run.endTime) / 2;
          const left = (midpoint / Math.max(1, duration)) * 100;
          return (
            <span
              key={`bpm-run-${run.startTime}-${run.bpm}`}
              className="bg-surface-3/80 text-text border-border absolute top-2 -translate-x-1/2 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums backdrop-blur-sm"
              style={{ left: `${left}%` }}
              data-testid="bpm-run-label"
              data-bpm={run.bpm}
            >
              {run.bpm}
            </span>
          );
        })}
      </div>
      <div className="text-text-subtle absolute right-2 bottom-1 text-[9px] font-medium tracking-[0.12em] uppercase">
        BPM
      </div>
      {points.length === 0 && (
        <div
          className="text-text-subtle pointer-events-none absolute inset-0 flex items-center justify-center text-xs italic"
          data-testid="bpm-lane-empty"
        >
          waiting for BPM analysis…
        </div>
      )}
    </div>
  );
}

function WaveformLane({
  audio,
  onHover,
  onLeave,
}: {
  audio: SetAudio;
  onHover: (x: number, w: number) => void;
  onLeave: () => void;
}) {
  // Transport + current-time live in the left rail; the total-duration
  // label lives in the right rail. The lane itself just hosts the
  // canvas, so it shares horizontal extent with the BPM curve and the
  // track bands above/below it.
  const { containerRef, error } = audio;
  return (
    <div
      className="border-border/40 relative overflow-hidden border-b border-dashed"
      style={{ height: ROW_HEIGHTS.waveform }}
      data-testid="set-waveform"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => {
        const rect = (
          e.currentTarget as HTMLDivElement
        ).getBoundingClientRect();
        onHover(e.clientX - rect.left, rect.width);
      }}
      onPointerLeave={onLeave}
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
        data-testid="set-waveform-canvas"
      />
      {error && (
        <p
          className="text-destructive absolute inset-0 flex items-center justify-center text-xs"
          data-testid="set-waveform-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function TimeAxisLane({ duration }: { duration: number }) {
  const ticks = useMemo(() => {
    if (duration <= 0) return [] as number[];
    const candidates = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const target = duration / 8;
    const step =
      candidates.find((c) => c >= target) ?? candidates[candidates.length - 1];
    const out: number[] = [];
    // Skip t=0 — the rail's current-time readout already labels the
    // origin, so a "0:00" tick at the same X is just visual duplication.
    for (let t = step; t <= duration + 1e-3; t += step) out.push(t);
    return out;
  }, [duration]);

  return (
    <div
      className="border-border/60 bg-surface-1/40 relative border-b"
      style={{ height: ROW_HEIGHTS.axis }}
      data-testid="time-axis"
    >
      {ticks.map((t) => {
        const left = (t / Math.max(1, duration)) * 100;
        return (
          <div
            key={t}
            className="text-text-muted pointer-events-none absolute top-0 -translate-x-1/2 text-[10px] tabular-nums"
            style={{ left: `${left}%` }}
          >
            <span
              className="bg-border/60 absolute -top-px left-1/2 -translate-x-1/2"
              style={{ width: 1, height: 4 }}
            />
            <span className="block pt-1">{formatTimecode(t)}</span>
          </div>
        );
      })}
    </div>
  );
}

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

/** Tracks closer than this fraction of the total set duration are
 *  visually indistinguishable, so we collapse them into a single
 *  "slideshow" band that cycles through their cover art. */
const TRACK_GROUP_GAP_FRACTION = 0.012;

function isManual(t: DerivedRun): boolean {
  return "source" in t && (t as TrackTimelineEntry).source === "manual";
}

function groupOverlappingTracks(
  tracks: DerivedRun[],
  duration: number,
): DerivedRun[][] {
  if (tracks.length === 0) return [];
  const sorted = [...tracks].sort((a, b) => a.start_s - b.start_s);
  const gap = Math.max(8, duration * TRACK_GROUP_GAP_FRACTION);
  const groups: DerivedRun[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = groups[groups.length - 1];
    const prevEnd = Math.max(...prev.map((t) => t.end_s));
    const cur = sorted[i];
    // Manuals are always their own band — they're the user's
    // explicit placements, so squashing them into a Shazam group
    // would defeat the point of the edit.
    const breakGroup =
      isManual(cur) || prev.some(isManual) || cur.start_s - prevEnd >= gap;
    if (breakGroup) {
      groups.push([cur]);
    } else {
      prev.push(cur);
    }
  }
  return groups;
}

function TracksLane({
  scans,
  timeline,
  duration,
  selection,
  onFocusTrack,
  confirmed,
  onEditBounds,
}: {
  scans: AnalyserUiState["scans"];
  timeline: AnalyserUiState["timeline"];
  duration: number;
  selection: AnalyserUiState["selection"];
  onFocusTrack?: (trackKey: string) => void;
  confirmed?: Set<string>;
  onEditBounds?: (
    track: DerivedRun,
    bounds: { start_s: number | null; end_s: number | null },
  ) => void;
}) {
  const derived = useMemo(() => aggregateScans(scans), [scans]);
  const tracks: DerivedRun[] = timeline.length > 0 ? timeline : derived;
  const artworks = useTrackArtworks(tracks);
  const groups = useMemo(
    () => groupOverlappingTracks(tracks, duration),
    [tracks, duration],
  );
  return (
    <div
      className="bg-surface-1/30 relative overflow-hidden"
      style={{ height: ROW_HEIGHTS.tracks }}
      data-testid="tracks-lane"
    >
      {/* Scan-progress marks pinned to the bottom edge — visible during
          scanning, fade behind the track bands once a match lands. */}
      {bestPerScanPoint(scans).map((s) => {
        const left = (s.scan_s / duration) * 100;
        const matched = s.title != null;
        return (
          <div
            key={`scan-${s.scan_s}`}
            className={cn(
              "pointer-events-none absolute bottom-0 w-px",
              matched ? "bg-brand/60 h-2" : "bg-text-subtle/40 h-1",
            )}
            style={{ left: `${left}%` }}
            data-testid="scan-tick"
            data-matched={matched ? "true" : "false"}
          />
        );
      })}
      {groups.map((group, i) => {
        const groupStart = Math.min(...group.map((t) => t.start_s));
        const groupEnd = Math.max(...group.map((t) => t.end_s));
        // The raw ``end_s`` only spans the seconds Shazam actually
        // sampled — typically a handful of scan points, so bands look
        // like dots rather than the multi-minute tracks they represent.
        // Stretch each band to whichever comes first:
        //   - ``start + max(track duration_s)`` when known (manual
        //     entries that linked a SoundCloud track carry duration);
        //   - the next group's start (default cap);
        //   - a ``MAX_VISUAL_TRACK_S`` ceiling so an unidentified gap
        //     can't get wrongly attributed to one track.
        const MAX_VISUAL_TRACK_S = 600; // 10 min — typical longest DJ-set cut
        // A manual's ``end_s`` is an explicit user choice (the drag-edit
        // just persisted it). Trust it over every other heuristic —
        // including ``nextStart`` clamping — otherwise the band
        // re-stretches back as soon as the snapshot loads.
        const explicitEnd = group.reduce<number>((acc, t) => {
          if (!isManual(t)) return acc;
          return t.end_s > t.start_s + 0.5 ? Math.max(acc, t.end_s) : acc;
        }, 0);
        const knownDuration = group.reduce<number>((acc, t) => {
          const d = "duration_s" in t ? t.duration_s : null;
          return typeof d === "number" && d > 0 ? Math.max(acc, d) : acc;
        }, 0);
        const nextStart =
          i < groups.length - 1
            ? Math.min(...groups[i + 1].map((t) => t.start_s))
            : duration;
        // Priority: explicit user end > known SoundCloud duration >
        // next-track-start (capped by ``MAX_VISUAL_TRACK_S``).
        let visualEnd: number;
        if (explicitEnd > groupStart) {
          visualEnd = explicitEnd;
        } else {
          const targetEnd =
            knownDuration > 0
              ? groupStart + knownDuration
              : Math.max(groupEnd, groupStart) + MAX_VISUAL_TRACK_S;
          visualEnd = Math.max(
            Math.min(nextStart, targetEnd),
            groupStart + duration * 0.005,
          );
        }
        const left = (groupStart / duration) * 100;
        const width = ((visualEnd - groupStart) / duration) * 100;
        const isSelected = selection
          ? group.some(
              (t) =>
                t.start_s <= selection.start_s + 0.5 &&
                t.end_s >= selection.end_s - 0.5,
            )
          : false;
        // Every persisted track has a real id; the live ``DerivedRun``
        // fallback path falls back to start+title.
        const groupKey = `group-${groupStart}-${group
          .map((t) =>
            "id" in t ? `t${t.id}` : `${t.shazam_id ?? t.title}`,
          )
          .join("|")}`;
        return (
          <TrackBand
            key={groupKey}
            tracks={group}
            artworks={artworks}
            left={left}
            width={width}
            selected={isSelected}
            onFocusTrack={onFocusTrack}
            confirmed={confirmed}
            duration={duration}
            onEditBounds={onEditBounds}
          />
        );
      })}
    </div>
  );
}

/** Stable hue (0–360) per track so the band's tint visually identifies
 *  the track even when artwork isn't available yet. */
function trackHue(t: DerivedRun): number {
  const seed = t.shazam_id ?? `${t.title}|${t.artist ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** Pixel width the band expands to on hover so the cover is fully
 *  visible at a 1:1 aspect ratio. Matches the band's content height
 *  (lane height minus top-1/bottom-1 insets) for a square. */
const HOVER_EXPAND_PX = 20;

/** A track band on the timeline.
 *
 *  Renders one entry per track in the group as a small left-aligned
 *  cover thumbnail (no auto-cycling — flicker is annoying and made
 *  bands hard to read). The band's tint comes from the *primary*
 *  (earliest) track in the group; confirmed bands paint solid, the
 *  rest get a diagonal-stripe overlay so unidentified spans are
 *  visually distinct. */
function TrackBand({
  tracks,
  artworks,
  left,
  width,
  selected,
  onFocusTrack,
  confirmed,
  duration,
  onEditBounds,
}: {
  tracks: DerivedRun[];
  artworks: Map<string, string | null>;
  left: number;
  width: number;
  selected: boolean;
  onFocusTrack?: (trackKey: string) => void;
  confirmed?: Set<string>;
  /** Set duration in seconds — needed to translate the drag handle's
   *  pixel delta into a time offset. */
  duration: number;
  /** Commit a drag-edit. Called on pointerup with the final bounds in
   *  seconds. ``null`` means leave that bound untouched. The parent
   *  decides whether to PATCH a manual override or convert a Shazam
   *  run via hide + add manually. */
  onEditBounds?: (
    track: DerivedRun,
    bounds: { start_s: number | null; end_s: number | null },
  ) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const primary = tracks[0];
  const tint = `oklch(0.62 0.14 ${trackHue(primary)})`;
  // Match the tracklist's per-row key so a band-click scrolls the
  // matching row into view. Persisted tracks key by id; the live-scan
  // ``DerivedRun`` fallback uses start+title (no row to focus yet).
  const focusKey =
    "id" in primary
      ? String((primary as TrackTimelineEntry).id)
      : `${primary.start_s}-${primary.title}`;
  // A group is "confirmed" when *every* track in it is checked — partial
  // confirmation still reads as work in progress, so the stripe stays.
  const isConfirmed =
    !!confirmed &&
    tracks.every((t) =>
      confirmed.has(`${t.start_s}-${t.shazam_id ?? t.title}`),
    );

  const tooltip = tracks
    .map(
      (t) =>
        `${t.title}${t.artist ? " — " + t.artist : ""}${tracks.length > 1 ? ` (${formatTimecode(t.start_s)})` : ""}`,
    )
    .join("\n");

  // Stripes mix the tint with the lane background instead of going
  // transparent — produces a chunkier, more legible pattern at small
  // sizes than the previous alpha-stripe approach.
  const stripeBg = `repeating-linear-gradient(135deg, ${tint} 0 7px, color-mix(in oklch, ${tint} 30%, oklch(0.18 0.01 260)) 7px 14px)`;

  // ---- Drag-to-edit start/end ---------------------------------------------
  // ``dragDelta`` (seconds) is applied locally during a drag so the band
  // visually follows the pointer without waiting for the API round-trip.
  // Committed on pointerup via ``onEditBounds``.
  const [dragSide, setDragSide] = useState<"start" | "end" | null>(null);
  const [dragDelta, setDragDelta] = useState(0);
  const dragInfoRef = useRef<{
    laneRect: DOMRect;
    originX: number;
    track: DerivedRun;
    side: "start" | "end";
  } | null>(null);

  const beginDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    side: "start" | "end",
  ) => {
    if (!onEditBounds || duration <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    // The band's parent (``tracks-lane``) is the % reference for left/width
    // so we measure the drag against its rect, not the band's own.
    const lane = (e.currentTarget as HTMLElement).closest(
      '[data-testid="tracks-lane"]',
    );
    if (!(lane instanceof HTMLElement)) return;
    dragInfoRef.current = {
      laneRect: lane.getBoundingClientRect(),
      originX: e.clientX,
      track: primary,
      side,
    };
    setDragSide(side);
    setDragDelta(0);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const info = dragInfoRef.current;
    if (!info) return;
    const pxPerSecond = info.laneRect.width / duration;
    if (pxPerSecond <= 0) return;
    setDragDelta((e.clientX - info.originX) / pxPerSecond);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const info = dragInfoRef.current;
    if (!info) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const pxPerSecond = info.laneRect.width / duration;
    const deltaS = (e.clientX - info.originX) / pxPerSecond;
    dragInfoRef.current = null;
    setDragSide(null);
    setDragDelta(0);
    if (Math.abs(deltaS) < 0.25) return; // sub-quarter-second jiggle, ignore
    // The painted band extends past the data's ``end_s`` (Shazam runs
    // span only their scan points; the visual band stretches to the
    // next group's start or to ``start + duration_s``). Drag deltas
    // must be measured against the *visible* edges, not the data, or
    // shrinking a long-looking band drags ``end_s`` past ``start_s``
    // and the resulting manual lands at the wrong (often duplicated)
    // position.
    const visibleStartS = (left / 100) * duration;
    const visibleEndS = ((left + width) / 100) * duration;
    if (info.side === "start") {
      const newStart = Math.max(
        0,
        Math.min(duration, visibleStartS + deltaS),
      );
      onEditBounds?.(info.track, { start_s: newStart, end_s: null });
    } else {
      const newEnd = Math.max(
        info.track.start_s + 1,
        Math.min(duration, visibleEndS + deltaS),
      );
      onEditBounds?.(info.track, { start_s: null, end_s: newEnd });
    }
  };

  // Translate the live drag delta into a percentage offset so the
  // band's left/width follow the pointer without re-laying out the
  // whole timeline.
  const liveLeftDelta =
    dragSide === "start" && duration > 0 ? (dragDelta / duration) * 100 : 0;
  const liveWidthDelta =
    duration > 0 ? (dragDelta / duration) * 100 : 0;
  const visualLeft = left + liveLeftDelta;
  const visualWidth =
    dragSide === "start"
      ? width - liveWidthDelta
      : dragSide === "end"
        ? width + liveWidthDelta
        : width;

  return (
    <button
      type="button"
      className={cn(
        "absolute top-1 bottom-1 flex cursor-pointer items-stretch overflow-hidden rounded-md shadow-sm ring-1 transition-[width,min-width,box-shadow] duration-150",
        selected
          ? "ring-brand shadow-brand/30 shadow-md"
          : isConfirmed
            ? "ring-brand/30 hover:ring-brand/60"
            : "ring-text-subtle/30 hover:ring-text-subtle/60",
        hovered && "z-10",
      )}
      style={{
        left: `${visualLeft}%`,
        width: `${Math.max(0.05, visualWidth)}%`,
        minWidth: hovered ? `${HOVER_EXPAND_PX}px` : "4px",
        background: isConfirmed ? tint : stripeBg,
      }}
      data-confirmed={isConfirmed ? "true" : "false"}
      data-dragging={dragSide ?? "none"}
      title={tooltip}
      data-testid="track-band"
      data-group-size={tracks.length}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        // Suppress the focus-track click when releasing a drag, otherwise
        // the tracklist scrolls under the user's pointer at drag end.
        if (dragSide !== null || Math.abs(dragDelta) > 0.25) {
          e.stopPropagation();
          return;
        }
        e.stopPropagation();
        onFocusTrack?.(focusKey);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Cover strip — left-aligned, one square per track, no cycling.
          Each cover is a square the height of the band so the band
          reads as a row of mini album tiles. */}
      <div className="pointer-events-none flex h-full shrink-0 items-stretch">
        {tracks.map((t, i) => {
          const k = trackKey(t);
          const art = artworks.get(k) ?? null;
          if (!art) return null;
          // ``trackKey`` falls back to ``title|artist`` when no shazam_id
          // is set; two entries at the same start can share that
          // fallback (e.g. a manual sitting on top of the original
          // Shazam run during a drag-conversion). Append the index so
          // React still gets a unique key per child.
          return (
            <img
              key={`${k}#${i}`}
              src={art}
              alt=""
              aria-hidden="true"
              className="aspect-square h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          );
        })}
      </div>
      {/* Confirmed indicator — a slim brand bar pinned to the bottom
          edge plus a check chip. Reads cleanly even when the band is
          narrow because the bar spans the full width. */}
      {isConfirmed && (
        <>
          <span
            className="bg-brand pointer-events-none absolute right-0 bottom-0 left-0 h-0.5"
            aria-hidden="true"
          />
          <span
            className="bg-brand text-surface-1 pointer-events-none absolute top-0.5 right-0.5 grid size-3.5 place-items-center rounded-full ring-1 ring-black/20"
            aria-label="Confirmed"
            title="Confirmed"
          >
            <Check className="size-2.5" strokeWidth={3.5} />
          </span>
        </>
      )}
      {tracks.length > 1 && !isConfirmed && (
        <span
          className="bg-black/55 text-text pointer-events-none absolute right-0.5 bottom-0.5 rounded px-1 text-[9px] font-semibold tabular-nums backdrop-blur-sm"
          aria-hidden="true"
        >
          ×{tracks.length}
        </span>
      )}
      {/* Drag handles — invisible at rest, fade in on band hover so
          they don't visually clutter the timeline. The handle owns
          ``cursor-ew-resize``; the parent button only enters drag
          mode through ``onPointerDown`` here. Tap target is wider
          than the visible bar so narrow bands stay grabbable. */}
      {onEditBounds && (
        <>
          <div
            role="presentation"
            onPointerDown={(e) => beginDrag(e, "start")}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={cn(
              "absolute top-0 bottom-0 left-0 w-2 cursor-ew-resize",
              "before:bg-text/70 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:opacity-0 before:transition-opacity before:duration-150",
              hovered && "before:opacity-90",
              dragSide === "start" && "before:bg-brand before:opacity-100",
            )}
            data-testid="track-band-handle"
            data-handle="start"
          />
          <div
            role="presentation"
            onPointerDown={(e) => beginDrag(e, "end")}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={cn(
              "absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize",
              "after:bg-text/70 after:absolute after:inset-y-1 after:right-0 after:w-0.5 after:rounded-full after:opacity-0 after:transition-opacity after:duration-150",
              hovered && "after:opacity-90",
              dragSide === "end" && "after:bg-brand after:opacity-100",
            )}
            data-testid="track-band-handle"
            data-handle="end"
          />
        </>
      )}
    </button>
  );
}

function SelectionMarker({
  selection,
  duration,
  totalHeight,
}: {
  selection: NonNullable<AnalyserUiState["selection"]>;
  duration: number;
  totalHeight: number;
}) {
  const left = (selection.start_s / duration) * 100;
  const width = ((selection.end_s - selection.start_s) / duration) * 100;
  return (
    <div
      data-testid="timeline-selection"
      className="bg-brand/10 border-brand/40 pointer-events-none absolute top-0 border-r-2 border-l-2"
      style={{
        left: `${left}%`,
        width: `${width}%`,
        height: totalHeight,
      }}
    />
  );
}
