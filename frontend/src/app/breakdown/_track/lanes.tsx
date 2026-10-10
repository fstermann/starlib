"use client";

import { Fragment, useRef, useState, type ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  barStartS,
  formatClock,
  SECTION_LABELS,
  sectionColor,
  type Grid,
  type Section,
  type TrackFeatures,
} from "@/lib/track-breakdown";
import {
  mergeWithNext,
  moveBoundary,
  renameSection,
  splitAt,
} from "@/lib/track-breakdown-sections";
import { cn } from "@/lib/utils";

/** The visible window: `start` is the (fractional, 1-based) bar at the left edge. */
export interface View {
  start: number;
  span: number;
}

/** Width of the lane name and controls column. */
export const GUTTER_PX = 200;
/** Bars visible at or below which waveforms get a 16th-note grid. */
export const GRID_MAX_SPAN = 16;
const LEVEL_FLOOR_DB = -50;
const BRIGHTNESS_MAX_HZ = 8000;

function percent(view: View, bar: number): number {
  return ((bar - view.start) / view.span) * 100;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Map a dB level to 0..1 above `floor`. */
function level(db: number, floor = LEVEL_FLOOR_DB): number {
  return clamp01((db - floor) / -floor);
}

/** SVG whose x axis is bars: bar `b` spans `[b - 1, b]`. */
function BarSvg({
  view,
  height,
  children,
  testId,
}: {
  view: View;
  height: number;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <svg
      viewBox={`${view.start - 1} 0 ${view.span} ${height}`}
      preserveAspectRatio="none"
      className="block h-full w-full"
      data-testid={testId}
    >
      {children}
    </svg>
  );
}

/** One timeline row: a fixed gutter for name and controls, then the plot. */
export function LaneRow({
  label,
  controls,
  height,
  onSeekBar,
  view,
  children,
  testId,
}: {
  label: ReactNode;
  controls?: ReactNode;
  height: number;
  onSeekBar?: (bar: number) => void;
  view: View;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="grid border-b border-[var(--border)]"
      style={{ height, gridTemplateColumns: `${GUTTER_PX}px 1fr` }}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-center gap-1 border-r border-[var(--border)] px-2">
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">
          {label}
        </span>
        {controls}
      </div>
      <div
        className="relative overflow-hidden"
        onClick={(e) => {
          if (!onSeekBar) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onSeekBar(
            view.start + ((e.clientX - rect.left) / rect.width) * view.span,
          );
        }}
      >
        {children}
      </div>
    </div>
  );
}

function barCount(section: Section): number {
  return section.end_bar - section.start_bar + 1;
}

/** Bar numbers with times; beat ticks when zoomed to a few bars. */
export function Ruler({ view, grid }: { view: View; grid: Grid }) {
  const step = [1, 2, 4, 8, 16, 32].find((s) => view.span / s <= 16) ?? 32;
  const first = Math.max(1, Math.ceil((view.start - 1) / step) * step + 1);
  const bars: number[] = [];
  for (let bar = first; bar < view.start + view.span; bar += step)
    bars.push(bar);
  const beats =
    view.span <= 8
      ? Array.from(
          {
            length:
              Math.ceil(view.span) * grid.beats_per_bar + grid.beats_per_bar,
          },
          (_, i) => Math.floor(view.start) + i / grid.beats_per_bar,
        ).filter(
          (b) => b % 1 !== 0 && b >= view.start && b < view.start + view.span,
        )
      : [];
  return (
    <div className="relative h-full" data-testid="track-ruler">
      {beats.map((b) => (
        <div
          key={`beat-${b}`}
          className="absolute bottom-0 h-1.5 w-px bg-[var(--border-strong)]"
          style={{ left: `${percent(view, b)}%` }}
        />
      ))}
      {bars.map((bar) => (
        <div
          key={bar}
          className="absolute top-0 flex h-full flex-col justify-between border-l border-[var(--border-strong)] pl-1"
          style={{ left: `${percent(view, bar)}%` }}
        >
          <span className="text-xs text-[var(--text)] tabular-nums">{bar}</span>
          <span className="text-2xs text-[var(--text-subtle)] tabular-nums">
            {formatClock(barStartS(grid, bar))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Coloured, labelled sections: click to seek, drag edges, right-click to edit. */
export function SectionLane({
  view,
  sections,
  loopIndex,
  onChange,
  onSeekBar,
  onLoop,
}: {
  view: View;
  sections: Section[];
  loopIndex: number | null;
  onChange: (sections: Section[]) => void;
  onSeekBar: (bar: number) => void;
  onLoop: (index: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Section[] | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menuBar, setMenuBar] = useState(1);
  const shown = preview ?? sections;

  const barAtPointer = (clientX: number): number => {
    const rect = container.current!.getBoundingClientRect();
    return view.start + ((clientX - rect.left) / rect.width) * view.span;
  };

  const startDrag = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) =>
      setPreview(
        moveBoundary(sections, index, Math.round(barAtPointer(ev.clientX))),
      );
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPreview(null);
      const moved = moveBoundary(
        sections,
        index,
        Math.round(barAtPointer(ev.clientX)),
      );
      if (moved !== sections) onChange(moved);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={container}
      className="relative h-full"
      data-testid="track-sections"
    >
      {shown.map((s, i) => {
        const left = percent(view, s.start_bar);
        const width = ((s.end_bar - s.start_bar + 1) / view.span) * 100;
        if (left + width < 0 || left > 100) return null;
        return (
          <Fragment key={`${s.start_bar}-${i}`}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`${s.label}, ${barCount(s)} bars, bars ${s.start_bar} to ${s.end_bar}`}
                  title={`Bars ${s.start_bar}–${s.end_bar}`}
                  data-testid="track-section"
                  data-label={s.label}
                  data-start-bar={s.start_bar}
                  data-end-bar={s.end_bar}
                  className={cn(
                    "absolute inset-y-1 flex items-center overflow-hidden rounded-sm px-1.5 text-xs font-medium text-black",
                    loopIndex === i && "ring-2 ring-[var(--brand)] ring-inset",
                  )}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: sectionColor(s.label),
                    boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${sectionColor(s.label)} 55%, black)`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeekBar(s.start_bar);
                  }}
                  onDoubleClick={() => setRenaming(i)}
                  onContextMenu={(e) =>
                    setMenuBar(Math.floor(barAtPointer(e.clientX)))
                  }
                >
                  {renaming === i ? (
                    <RenameInput
                      initial={s.label}
                      onDone={(label) => {
                        setRenaming(null);
                        if (label !== null)
                          onChange(renameSection(sections, i, label));
                      }}
                    />
                  ) : (
                    <span
                      className="truncate"
                      // Keep the label in view when the section starts off-screen.
                      style={{
                        marginLeft: `${left < 0 ? (-left / width) * 100 : 0}%`,
                      }}
                    >
                      {s.label}
                      <span
                        className="ml-1 font-normal tabular-nums opacity-60"
                        data-testid="track-section-bars"
                      >
                        {barCount(s)} {barCount(s) === 1 ? "bar" : "bars"}
                      </span>
                    </span>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem className="text-xs" onSelect={() => onLoop(i)}>
                  {loopIndex === i ? "Stop looping" : "Loop section"}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-xs"
                  onSelect={() => setRenaming(i)}
                >
                  Rename…
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-xs"
                  disabled={menuBar <= s.start_bar}
                  onSelect={() => onChange(splitAt(sections, menuBar))}
                  data-testid="track-section-split"
                >
                  Split at bar {menuBar}
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-xs"
                  disabled={i === sections.length - 1}
                  onSelect={() => onChange(mergeWithNext(sections, i))}
                  data-testid="track-section-merge"
                >
                  Merge with next
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {i < shown.length - 1 && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Boundary at bar ${shown[i + 1].start_bar}`}
                data-testid="track-section-boundary"
                className="absolute inset-y-0 z-10 w-2 -translate-x-1/2 cursor-col-resize"
                style={{ left: `${percent(view, s.end_bar + 1)}%` }}
                onPointerDown={startDrag(i)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (label: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <input
        autoFocus
        list="track-section-labels"
        value={value}
        maxLength={40}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => onDone(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone(value);
          if (e.key === "Escape") onDone(null);
        }}
        className="h-5 w-full min-w-0 rounded-sm bg-[var(--surface-2)] px-1 text-xs text-[var(--text)] outline-none"
        data-testid="track-section-rename"
      />
      <datalist id="track-section-labels">
        {SECTION_LABELS.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
    </>
  );
}

/** Neutral and told apart by dash, since the chart colours belong to the stems. */
export const CURVES = [
  { id: "loudness", label: "Loudness", color: "var(--text)", dash: "" },
  { id: "width", label: "Width", color: "var(--text-muted)", dash: "6 4" },
  {
    id: "brightness",
    label: "Brightness",
    color: "var(--text-muted)",
    dash: "0.5 3",
  },
] as const;
export type CurveId = (typeof CURVES)[number]["id"];

function curveValues(features: TrackFeatures, id: CurveId): number[] {
  const mix = features.sources.mix;
  if (id === "loudness") return mix.db.map((db) => level(db));
  if (id === "width") return mix.width.map((w) => clamp01(w));
  return mix.centroid_hz.map((hz) => clamp01(hz / BRIGHTNESS_MAX_HZ));
}

/** Loudness, stereo width and brightness of the mix per bar. */
export function CurveLane({
  view,
  features,
  visible,
}: {
  view: View;
  features: TrackFeatures;
  visible: Record<CurveId, boolean>;
}) {
  const height = 100;
  return (
    <BarSvg view={view} height={height} testId="track-curves">
      {CURVES.filter((c) => visible[c.id]).map((c) => (
        <polyline
          key={c.id}
          data-curve={c.id}
          fill="none"
          stroke={c.color}
          strokeWidth={1.5}
          strokeDasharray={c.dash || undefined}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          points={curveValues(features, c.id)
            .map((v, i) => `${i + 0.5},${height - v * (height - 4) - 2}`)
            .join(" ")}
        />
      ))}
    </BarSvg>
  );
}

/** Whole-track strip of sections with the visible window; click to jump there. */
export function Overview({
  sections,
  nBars,
  view,
  onCenter,
}: {
  sections: Section[];
  nBars: number;
  view: View;
  onCenter: (bar: number) => void;
}) {
  return (
    <div
      className="relative h-4 cursor-pointer overflow-hidden rounded-sm"
      data-testid="track-overview"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onCenter(1 + ((e.clientX - rect.left) / rect.width) * nBars);
      }}
    >
      {sections.map((s) => (
        <div
          key={s.start_bar}
          className="absolute inset-y-0 opacity-60"
          style={{
            left: `${((s.start_bar - 1) / nBars) * 100}%`,
            width: `${((s.end_bar - s.start_bar + 1) / nBars) * 100}%`,
            background: sectionColor(s.label),
          }}
        />
      ))}
      <div
        className="absolute inset-y-0 rounded-sm border border-[var(--text)]"
        style={{
          left: `${((view.start - 1) / nBars) * 100}%`,
          width: `${(view.span / nBars) * 100}%`,
        }}
      />
    </div>
  );
}
