"use client";

import { useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { AnalyserUiState } from "../_state";

interface TimelineProps {
  state: AnalyserUiState;
  onSelectRange: (start_s: number, end_s: number) => void;
}

const ROW_HEIGHTS = {
  bpm: 80,
  sections: 36,
  tracks: 56,
} as const;

const TOTAL_HEIGHT =
  ROW_HEIGHTS.bpm + ROW_HEIGHTS.sections + ROW_HEIGHTS.tracks + 16;

export function AnalyserTimeline({ state, onSelectRange }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

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

  return (
    <div
      ref={containerRef}
      className="border-border bg-surface-2 relative w-full overflow-hidden rounded-lg border"
      style={{ height: TOTAL_HEIGHT }}
      data-testid="analyser-timeline"
      onPointerDown={(e) => {
        const rect = (
          e.currentTarget as HTMLDivElement
        ).getBoundingClientRect();
        setDrag({ x0: e.clientX - rect.left, x1: e.clientX - rect.left });
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
      />
      <SectionsLane
        sections={state.sections}
        duration={duration}
        selection={state.selection}
      />
      <TracksLane
        sections={state.sections}
        tracks={state.tracks}
        duration={duration}
      />
      {drag && (
        <div
          className="bg-brand/15 border-brand/50 pointer-events-none absolute top-0 bottom-0 border"
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
  );
}

function BpmLane({
  windows,
  duration,
  bpmExtent,
}: {
  windows: AnalyserUiState["windows"];
  duration: number;
  bpmExtent: readonly [number, number];
}) {
  const [lo, hi] = bpmExtent;
  const range = Math.max(1, hi - lo);
  const path =
    windows.length === 0
      ? ""
      : windows
          .map((w, i) => {
            const x = ((w.start_s + w.end_s) / 2 / duration) * 100;
            const y = ((hi - w.bpm) / range) * 100;
            return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
          })
          .join(" ");
  return (
    <div
      className="border-border relative border-b"
      style={{ height: ROW_HEIGHTS.bpm }}
      data-testid="bpm-lane"
    >
      <div className="text-text-muted absolute top-1 left-2 text-[10px] tracking-wide uppercase">
        BPM {Math.round(lo)}–{Math.round(hi)}
      </div>
      <svg
        className="absolute inset-0"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        {windows.map((w, i) => {
          const x = ((w.start_s + w.end_s) / 2 / duration) * 100;
          const y = ((hi - w.bpm) / range) * 100;
          return (
            <circle
              key={`${w.start_s}-${i}`}
              cx={x}
              cy={y}
              r={1.4}
              className={cn(
                "fill-current",
                w.confidence === "high"
                  ? "text-brand"
                  : w.confidence === "medium"
                    ? "text-text-muted"
                    : "text-text-subtle",
              )}
            />
          );
        })}
        {path && (
          <path
            d={path}
            stroke="currentColor"
            strokeWidth={0.5}
            fill="none"
            className="text-brand/70"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}

function SectionsLane({
  sections,
  duration,
  selection,
}: {
  sections: AnalyserUiState["sections"];
  duration: number;
  selection: AnalyserUiState["selection"];
}) {
  return (
    <div
      className="border-border bg-surface-1 relative border-b"
      style={{ height: ROW_HEIGHTS.sections }}
      data-testid="sections-lane"
    >
      {sections.map((s) => {
        const left = (s.start_s / duration) * 100;
        const width = ((s.end_s - s.start_s) / duration) * 100;
        const isSelected =
          selection &&
          s.start_s <= selection.start_s + 0.5 &&
          s.end_s >= selection.end_s - 0.5;
        return (
          <div
            key={s.section_index}
            data-testid="section-block"
            className={cn(
              "absolute top-1 bottom-1 rounded border",
              isSelected
                ? "bg-brand-soft border-brand"
                : "bg-surface-3 border-border",
            )}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`Section ${s.section_index + 1}`}
          />
        );
      })}
    </div>
  );
}

function TracksLane({
  sections,
  tracks,
  duration,
}: {
  sections: AnalyserUiState["sections"];
  tracks: AnalyserUiState["tracks"];
  duration: number;
}) {
  return (
    <div
      className="bg-surface-1 relative"
      style={{ height: ROW_HEIGHTS.tracks }}
      data-testid="tracks-lane"
    >
      {sections.map((s) => {
        const t = tracks.get(s.section_index);
        const left = (s.start_s / duration) * 100;
        const width = ((s.end_s - s.start_s) / duration) * 100;
        return (
          <div
            key={s.section_index}
            className="absolute top-1 bottom-1 truncate px-2 text-xs"
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            {t?.title ? (
              <span className="text-text" data-testid="track-label">
                <span className="font-medium">{t.title}</span>
                {t.artist && (
                  <span className="text-text-muted"> — {t.artist}</span>
                )}
              </span>
            ) : (
              <span className="text-text-subtle italic">unidentified</span>
            )}
          </div>
        );
      })}
    </div>
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
