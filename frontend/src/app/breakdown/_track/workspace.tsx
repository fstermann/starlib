"use client";

import {
  AudioWaveform,
  ChartSpline,
  ChevronRight,
  Drum,
  Guitar,
  MicVocal,
  Pause,
  Piano,
  Play,
  Repeat,
  RotateCcw,
  Rows3,
  Ruler as RulerIcon,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
  barAt,
  barStartS,
  DRUM_PART_NAMES,
  formatClock,
  resetSections,
  saveSections,
  STEM_COLORS,
  STEM_NAMES,
  stemLabel,
  type Section,
  type StemName,
  type TrackBreakdown,
} from "@/lib/track-breakdown";
import { sectionIndexAt } from "@/lib/track-breakdown-sections";
import { cn } from "@/lib/utils";

import { SpectrumPanel, WaveformLane } from "./canvases";
import { TrackCommands } from "./commands";
import { GridEditor } from "./grid-editor";
import {
  CurveLane,
  CURVES,
  GRID_MAX_SPAN,
  GUTTER_PX,
  LaneRow,
  Overview,
  Ruler,
  SectionLane,
  type CurveId,
  type View,
} from "./lanes";
import {
  DRUM_PARTS,
  laneGains,
  ORIGINAL,
  PLAYED_STEMS,
  useStemPlayer,
  type LaneName,
  type StemPlayerControls,
} from "./use-stem-player";

const ZOOM_PRESETS = [
  { label: "Track", span: null },
  { label: "32 bars", span: 32 },
  { label: "8 bars", span: 8 },
  { label: "1 bar", span: 1 },
] as const;
const MIN_SPAN = 1;

const STEM_ICONS: Record<StemName, LucideIcon> = {
  drums: Drum,
  bass: Guitar,
  other: Piano,
  vocals: MicVocal,
};

const FX_HINT =
  "Vocals stem, mostly silent: on instrumentals it picks up mid-range hits and effects";

/** While playing, show the page of `view`'s width that holds the playhead. */
function pageTo(view: View, bar: number, nBars: number): View {
  if (bar >= view.start && bar < view.start + view.span) return view;
  const pages = Math.floor((bar - view.start) / view.span);
  return clampView({ ...view, start: view.start + pages * view.span }, nBars);
}

function clampView(view: View, nBars: number): View {
  const span = Math.min(Math.max(view.span, MIN_SPAN), nBars);
  const start = Math.min(Math.max(view.start, 1), nBars + 1 - span);
  return { start, span };
}

/** Explore one analysed track: sections, stems, curves and groove on a bar timeline. */
export function TrackWorkspace({
  result,
  onResult,
  onRemeasure,
}: {
  result: TrackBreakdown;
  onResult: (result: TrackBreakdown) => void;
  onRemeasure: () => void;
}) {
  const path = useSearchParams().get("path") ?? "";
  const { features } = result;
  const grid = features.grid;
  const nBars = grid.n_bars;
  const player = useStemPlayer(result.digest, api.getAudioUrl(path));
  const gains = laneGains(player.mix);
  const [baseView, setBaseView] = useState<View>({ start: 1, span: nBars });
  const [sections, setSections] = useState(result.sections);
  const [loopIndex, setLoopIndex] = useState<number | null>(null);
  const [curves, setCurves] = useState<Record<CurveId, boolean>>({
    loudness: true,
    width: true,
    brightness: true,
  });
  const lanesRef = useRef<HTMLDivElement>(null);

  const playheadBar = barAt(grid, player.position);
  const view = player.playing ? pageTo(baseView, playheadBar, nBars) : baseView;

  const togglePlayback = useCallback(() => {
    // Keep the page playback had reached instead of jumping back on pause.
    if (player.playing) setBaseView(view);
    player.toggle();
  }, [player, view]);
  const toggleRef = useRef(togglePlayback);
  useEffect(() => {
    toggleRef.current = togglePlayback;
  });

  const seekBar = useCallback(
    (bar: number) => player.seek(Math.max(0, barStartS(grid, bar))),
    [grid, player],
  );

  const persist = useCallback(
    async (next: Section[]) => {
      const previous = sections;
      setSections(next);
      // Edits shift section indices, so a running loop would point elsewhere.
      setLoopIndex(null);
      player.setLoop(null);
      try {
        onResult(await saveSections(result.digest, next));
      } catch (err) {
        setSections(previous);
        toast.error(`Couldn't save sections: ${String(err)}`);
      }
    },
    [onResult, player, result.digest, sections],
  );

  const reset = useCallback(async () => {
    const updated = await resetSections(result.digest);
    setSections(updated.sections);
    setLoopIndex(null);
    onResult(updated);
  }, [onResult, result.digest]);

  const toggleLoop = useCallback(
    (index: number | null) => {
      if (index === null || index < 0 || index === loopIndex) {
        setLoopIndex(null);
        player.setLoop(null);
        return;
      }
      const s = sections[index];
      setLoopIndex(index);
      player.setLoop({
        start: Math.max(0, barStartS(grid, s.start_bar)),
        end: barStartS(grid, s.end_bar + 1),
      });
    },
    [grid, loopIndex, player, sections],
  );

  const loopAtPlayhead = useCallback(
    () =>
      toggleLoop(
        sectionIndexAt(sections, Math.max(1, Math.floor(playheadBar))),
      ),
    [playheadBar, sections, toggleLoop],
  );

  // Ctrl/Cmd + wheel zooms around the pointer; horizontal wheel pans.
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const plotWidth = rect.width - GUTTER_PX;
      const frac = (e.clientX - rect.left - GUTTER_PX) / plotWidth;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setBaseView((v) => {
          const span = v.span * Math.exp(e.deltaY * 0.01);
          const anchor = v.start + frac * v.span;
          return clampView({ start: anchor - frac * span, span }, nBars);
        });
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault();
        const delta = e.shiftKey ? e.deltaY : e.deltaX;
        setBaseView((v) =>
          clampView(
            { ...v, start: v.start + (delta / plotWidth) * v.span },
            nBars,
          ),
        );
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [nBars]);

  // Space toggles playback unless typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.code !== "Space" ||
        target.closest("input, textarea, [contenteditable]")
      )
        return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const zoomTo = (span: number | null) =>
    setBaseView((v) =>
      span === null
        ? { start: 1, span: nBars }
        : clampView(
            {
              start: Math.floor(
                player.position > 0 ? playheadBar - span / 2 + 0.5 : v.start,
              ),
              span,
            },
            nBars,
          ),
    );

  const playheadFrac = (playheadBar - view.start) / view.span;
  const showGrid = view.span <= GRID_MAX_SPAN;
  const [drumPartsOpen, setDrumPartsOpen] = useState(false);
  const [curvesOpen, setCurvesOpen] = useState(false);

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
      <TrackCommands
        sectionsEdited={result.sections_edited}
        looping={loopIndex !== null}
        onLoop={loopAtPlayhead}
        onResetSections={() => void reset()}
      />
      <Header result={result} onRemeasure={onRemeasure} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={togglePlayback}
          disabled={!player.ready}
          aria-label={player.playing ? "Pause" : "Play"}
          data-testid="track-play"
        >
          {player.playing ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
        </Button>
        <span
          className="min-w-36 text-sm text-[var(--text)] tabular-nums"
          data-testid="track-position"
        >
          Bar {Math.max(1, playheadBar).toFixed(1)} ·{" "}
          {formatClock(player.position)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={loopAtPlayhead}
          className={cn(
            loopIndex !== null && "bg-[var(--brand-soft)] text-[var(--brand)]",
          )}
          aria-pressed={loopIndex !== null}
          data-testid="track-loop"
        >
          <Repeat className="size-4" />
          {loopIndex !== null
            ? `Looping ${sections[loopIndex]?.label}`
            : "Loop section"}
        </Button>
        {!player.ready && !player.error && (
          <span className="text-xs text-[var(--text-muted)]">
            Loading stems…
          </span>
        )}
        {player.error && (
          <span className="text-xs text-[var(--danger)]">
            Stems failed to load: {player.error}
          </span>
        )}
        <div
          className="ml-auto flex items-center gap-0.5"
          role="group"
          aria-label="Zoom"
        >
          {ZOOM_PRESETS.map((z) => (
            <Button
              key={z.label}
              variant="ghost"
              size="sm"
              onClick={() => zoomTo(z.span)}
              className={cn(
                (z.span ?? nBars) === view.span &&
                  "bg-[var(--brand-soft)] text-[var(--brand)]",
              )}
            >
              {z.label}
            </Button>
          ))}
        </div>
      </div>

      <Overview
        sections={sections}
        nBars={nBars}
        view={view}
        onCenter={(bar) =>
          setBaseView((v) =>
            clampView({ ...v, start: Math.round(bar - v.span / 2) }, nBars),
          )
        }
      />

      <div
        ref={lanesRef}
        className="min-h-0 shrink overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)]"
        data-testid="track-lanes"
      >
        <div className="relative">
          <div
            className="sticky top-0 z-10 bg-[var(--surface-2)]"
            data-testid="track-pinned-lanes"
          >
            <LaneRow
              label={<LaneLabel icon={RulerIcon}>Bar</LaneLabel>}
              height={36}
              view={view}
              onSeekBar={seekBar}
            >
              <Ruler view={view} grid={grid} />
            </LaneRow>
            <LaneRow
              label={<LaneLabel icon={Rows3}>Sections</LaneLabel>}
              height={36}
              view={view}
              controls={
                result.sections_edited && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => void reset()}
                        aria-label="Reset sections to detected"
                        data-testid="track-sections-reset"
                      >
                        <RotateCcw className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reset sections to detected</TooltipContent>
                  </Tooltip>
                )
              }
            >
              <SectionLane
                view={view}
                sections={sections}
                loopIndex={loopIndex}
                onChange={(next) => void persist(next)}
                onSeekBar={seekBar}
                onLoop={toggleLoop}
              />
            </LaneRow>
          </div>
          <LaneRow
            label={<LaneLabel icon={AudioWaveform}>Original</LaneLabel>}
            controls={<LaneControls lane={ORIGINAL} player={player} />}
            height={96}
            view={view}
            onSeekBar={seekBar}
            testId={`track-lane-${ORIGINAL}`}
          >
            {/* The stems sum back to the original, so the original needn't decode to be drawn. */}
            <AudibleLane audible={gains[ORIGINAL] > 0}>
              <WaveformLane
                view={view}
                grid={grid}
                waveform={player.waveform(PLAYED_STEMS)}
              />
            </AudibleLane>
          </LaneRow>
          <LaneRow
            label={
              <span className="flex flex-col gap-1">
                <ExpandToggle
                  open={curvesOpen}
                  onToggle={() => setCurvesOpen((open) => !open)}
                  testId="track-curves-toggle"
                >
                  <LaneLabel icon={ChartSpline}>Curves</LaneLabel>
                </ExpandToggle>
                {curvesOpen && (
                  <CurveLegend
                    visible={curves}
                    onToggle={(id) =>
                      setCurves((c) => ({ ...c, [id]: !c[id] }))
                    }
                  />
                )}
              </span>
            }
            height={curvesOpen ? 80 : 32}
            view={view}
            onSeekBar={seekBar}
            testId="track-lane-curves"
          >
            {curvesOpen && (
              <CurveLane view={view} features={features} visible={curves} />
            )}
          </LaneRow>
          {STEM_NAMES.map((lane) => (
            <Fragment key={lane}>
              <LaneRow
                label={
                  lane === "drums" ? (
                    <ExpandToggle
                      open={drumPartsOpen}
                      onToggle={() => setDrumPartsOpen((open) => !open)}
                      testId="track-drum-parts-toggle"
                    >
                      <StemLabel lane={lane} features={features} />
                    </ExpandToggle>
                  ) : (
                    <StemLabel lane={lane} features={features} />
                  )
                }
                controls={<LaneControls lane={lane} player={player} />}
                height={48}
                view={view}
                onSeekBar={seekBar}
                testId={`track-lane-${lane}`}
              >
                <AudibleLane audible={gains[lane] > 0}>
                  <WaveformLane
                    view={view}
                    grid={grid}
                    waveform={player.waveform(
                      lane === "drums" ? DRUM_PART_NAMES : [lane],
                    )}
                    color={STEM_COLORS[lane]}
                    showGrid={showGrid}
                    testId={`track-waveform-${lane}`}
                  />
                </AudibleLane>
              </LaneRow>
              {lane === "drums" &&
                drumPartsOpen &&
                DRUM_PARTS.map((part) => (
                  <LaneRow
                    key={part.id}
                    label={
                      <span className="pl-[22px] text-xs" title={part.hint}>
                        {part.label}
                      </span>
                    }
                    controls={<LaneControls lane={part.id} player={player} />}
                    height={36}
                    view={view}
                    onSeekBar={seekBar}
                    testId={`track-drum-part-${part.id}`}
                  >
                    <AudibleLane
                      audible={gains.drums > 0 && gains[part.id] > 0}
                    >
                      <WaveformLane
                        view={view}
                        grid={grid}
                        waveform={player.waveform([part.id])}
                        color={STEM_COLORS.drums}
                        showGrid={showGrid}
                        testId={`track-waveform-${part.id}`}
                      />
                    </AudibleLane>
                  </LaneRow>
                ))}
            </Fragment>
          ))}
          {playheadFrac >= 0 && playheadFrac <= 1 && (
            <div
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[var(--text)]"
              style={{
                left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${playheadFrac})`,
              }}
              data-testid="track-playhead"
            />
          )}
        </div>
      </div>

      <section
        className="flex min-h-40 flex-1 flex-col rounded-md border border-[var(--border)] bg-[var(--surface-2)]"
        aria-label="Spectrum"
      >
        <header className="flex items-baseline gap-2 border-b border-[var(--border)] px-3 py-1.5">
          <span className="text-sm text-[var(--text-muted)]">Spectrum</span>
          <span className="text-xs text-[var(--text-subtle)]">
            what you hear: solo a stem to see its spectrum
          </span>
        </header>
        <div className="min-h-0 flex-1 p-2">
          <SpectrumPanel analyser={player.analyser} playing={player.playing} />
        </div>
      </section>
    </main>
  );
}

function LaneLabel({
  icon: Icon,
  color = "currentColor",
  title,
  children,
}: {
  icon: LucideIcon;
  color?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2" title={title}>
      <Icon className="size-3.5 shrink-0" style={{ color }} aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

function StemLabel({
  lane,
  features,
}: {
  lane: StemName;
  features: TrackBreakdown["features"];
}) {
  const label = stemLabel(lane, features);
  const fx = label === "FX";
  return (
    <LaneLabel
      icon={fx ? Sparkles : STEM_ICONS[lane]}
      color={STEM_COLORS[lane]}
      title={fx ? FX_HINT : undefined}
    >
      {label}
    </LaneLabel>
  );
}

function ExpandToggle({
  open,
  onToggle,
  testId,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1 hover:text-[var(--text)]"
      onClick={onToggle}
      aria-expanded={open}
      data-testid={testId}
    >
      {children}
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-transform duration-[var(--dur-2)]",
          open && "rotate-90",
        )}
      />
    </button>
  );
}

/** Greys out a lane that is muted or silenced by another lane's solo. */
function AudibleLane({
  audible,
  children,
}: {
  audible: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "h-full transition-[opacity,filter]",
        !audible && "opacity-40 grayscale",
      )}
      data-audible={audible}
    >
      {children}
    </div>
  );
}

function Header({
  result,
  onRemeasure,
}: {
  result: TrackBreakdown;
  onRemeasure: () => void;
}) {
  const { grid, tonal, duration_s } = result.features;
  const bass = tonal.bass_peaks[0];
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-6 gap-y-1"
      data-testid="track-header"
    >
      <Stat
        label="Tempo"
        value={`${Number(grid.bpm.toFixed(2))} BPM`}
        testId="track-bpm"
      />
      <Stat
        label="Root"
        value={tonal.root ?? "–"}
        detail={
          bass ? `bass ${bass.note} at ${bass.hz.toFixed(1)} Hz` : undefined
        }
        testId="track-root"
      />
      <Stat label="Bars" value={String(grid.n_bars)} />
      <Stat label="Length" value={formatClock(duration_s)} />
      <GridEditor
        digest={result.digest}
        grid={grid}
        edited={result.grid_edited}
        onRemeasure={onRemeasure}
      />
      <p className="text-xs text-[var(--text-subtle)]">
        Stems are machine-separated and approximate: expect bleed between lanes.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span
        className="text-lg text-[var(--text)] tabular-nums"
        data-testid={testId}
      >
        {value}
      </span>
      {detail && (
        <span className="text-xs text-[var(--text-subtle)]">{detail}</span>
      )}
    </div>
  );
}

function CurveLegend({
  visible,
  onToggle,
}: {
  visible: Record<CurveId, boolean>;
  onToggle: (id: CurveId) => void;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      {CURVES.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onToggle(c.id)}
          aria-pressed={visible[c.id]}
          className={cn(
            "flex items-center gap-1.5 text-left text-xs",
            visible[c.id] ? "text-[var(--text)]" : "text-[var(--text-subtle)]",
          )}
        >
          <svg
            width={14}
            height={4}
            aria-hidden="true"
            style={{ opacity: visible[c.id] ? 1 : 0.3 }}
          >
            <line
              x1={1}
              x2={13}
              y1={2}
              y2={2}
              stroke={c.color}
              strokeWidth={1.5}
              strokeDasharray={c.dash || undefined}
              strokeLinecap="round"
            />
          </svg>
          {c.label}
        </button>
      ))}
    </span>
  );
}

function LaneControls({
  lane,
  player,
}: {
  lane: LaneName;
  player: StemPlayerControls;
}) {
  const mix = player.mix[lane];
  return (
    <div
      className="flex items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-pressed={mix.muted}
        aria-label={`Mute ${lane}`}
        onClick={() => player.updateLane(lane, { muted: !mix.muted })}
        className={cn(
          "flex size-6 items-center justify-center rounded-md text-xs font-medium",
          mix.muted
            ? "bg-[var(--brand-soft)] text-[var(--brand)]"
            : "text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]",
        )}
        data-testid={`track-mute-${lane}`}
      >
        M
      </button>
      <button
        type="button"
        aria-pressed={mix.solo}
        aria-label={`Solo ${lane}`}
        onClick={() => player.updateLane(lane, { solo: !mix.solo })}
        className={cn(
          "flex size-6 items-center justify-center rounded-md text-xs font-medium",
          mix.solo
            ? "bg-[var(--brand-soft)] text-[var(--brand)]"
            : "text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]",
        )}
        data-testid={`track-solo-${lane}`}
      >
        S
      </button>
      <Slider
        className="w-14"
        min={0}
        max={1}
        step={0.01}
        value={[mix.volume]}
        onValueChange={([volume]) => player.updateLane(lane, { volume })}
        aria-label={`${lane} volume`}
      />
    </div>
  );
}
