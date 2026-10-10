"use client";

import {
  AudioWaveform,
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
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  barAt,
  barStartS,
  DRUM_PART_NAMES,
  formatClock,
  originalAudioUrl,
  resetSections,
  saveSections,
  STEM_COLORS,
  STEM_NAMES,
  stemLabel,
  type Section,
  type StemName,
  type TrackBreakdown,
  type TrackSource,
} from "@/lib/track-breakdown";
import { sectionIndexAt } from "@/lib/track-breakdown-sections";
import { cn } from "@/lib/utils";

import { SpectrumPanel, WaveformLane } from "./canvases";
import { TrackCommands } from "./commands";
import { TrackHeader } from "./header";
import {
  CurveLane,
  CURVES,
  GRID_MAX_SPAN,
  GUTTER_PX,
  LaneRow,
  LoopBand,
  LoopBrace,
  Overview,
  Ruler,
  SectionLane,
  type BarRange,
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
  { label: "Fit", title: "Whole track", span: null },
  { label: "32", title: "32 bars", span: 32 },
  { label: "8", title: "8 bars", span: 8 },
  { label: "1", title: "1 bar", span: 1 },
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

/** A loop length such as "16 bars" or "1.25 bars". */
function formatBars(bars: number): string {
  const n = Number(bars.toFixed(2));
  return `${n} ${n === 1 ? "bar" : "bars"}`;
}

/** Bar `bar` rounded by `round` to a multiple of `step` bars from bar 1. */
function snapBar(bar: number, step: number, round: (x: number) => number) {
  return 1 + round((bar - 1) / step) * step;
}

function clampView(view: View, nBars: number): View {
  const span = Math.min(Math.max(view.span, MIN_SPAN), nBars);
  const start = Math.min(Math.max(view.start, 1), nBars + 1 - span);
  return { start, span };
}

/** Explore one analysed track: sections, stems, curves and groove on a bar timeline. */
export function TrackWorkspace({
  source,
  result,
  onResult,
  onRemeasure,
}: {
  source: TrackSource;
  result: TrackBreakdown;
  onResult: (result: TrackBreakdown) => void;
  onRemeasure: () => void;
}) {
  const { features } = result;
  const grid = features.grid;
  const nBars = grid.n_bars;
  const player = useStemPlayer(result.digest, originalAudioUrl(source));
  const gains = laneGains(player.mix);
  const [baseView, setBaseView] = useState<View>({ start: 1, span: nBars });
  const [sections, setSections] = useState(result.sections);
  // Like Ableton's loop brace: it stays put while looping is off.
  const [loop, setLoop] = useState<BarRange | null>(null);
  const [looping, setLooping] = useState(false);
  const [draftLoop, setDraftLoop] = useState<BarRange | null>(null);
  const [curves, setCurves] = useState<Record<CurveId, boolean>>({
    loudness: true,
    width: true,
    brightness: true,
  });
  const lanesRef = useRef<HTMLDivElement>(null);

  const playheadBar = barAt(grid, player.position);
  const view = player.playing ? pageTo(baseView, playheadBar, nBars) : baseView;

  // Like Ableton's start marker: play starts at the cue and stop returns to it.
  const [cue, setCue] = useState(0);
  const cueBar = barAt(grid, cue);

  const togglePlayback = useCallback(() => {
    if (player.playing) {
      player.pause();
      player.seek(cue);
      setBaseView(pageTo(view, cueBar, nBars));
    } else {
      player.seek(cue);
      void player.play();
    }
  }, [cue, cueBar, nBars, player, view]);

  /** Pause and resume where playback is, leaving the cue alone. */
  const continuePlayback = useCallback(() => {
    // Keep the page playback had reached instead of jumping back on pause.
    if (player.playing) setBaseView(view);
    player.toggle();
  }, [player, view]);

  const keyActions = useRef({ togglePlayback, continuePlayback });
  useEffect(() => {
    keyActions.current = { togglePlayback, continuePlayback };
  });

  const seekBar = useCallback(
    (bar: number) => {
      const seconds = Math.max(0, barStartS(grid, bar));
      setCue(seconds);
      player.seek(seconds);
    },
    [grid, player],
  );

  const persist = useCallback(
    async (next: Section[]) => {
      const previous = sections;
      setSections(next);
      try {
        onResult(await saveSections(result.digest, next));
      } catch (err) {
        setSections(previous);
        toast.error(`Couldn't save sections: ${String(err)}`);
      }
    },
    [onResult, result.digest, sections],
  );

  const reset = useCallback(async () => {
    const updated = await resetSections(result.digest);
    setSections(updated.sections);
    onResult(updated);
  }, [onResult, result.digest]);

  const { setLoop: setPlayerLoop } = player;
  useEffect(() => {
    setPlayerLoop(
      looping && loop
        ? {
            start: Math.max(0, barStartS(grid, loop.start)),
            end: barStartS(grid, loop.end),
          }
        : null,
    );
  }, [grid, loop, looping, setPlayerLoop]);

  const loopedSection =
    looping && loop
      ? sections.findIndex(
          (s) => s.start_bar === loop.start && s.end_bar + 1 === loop.end,
        )
      : -1;

  const loopSection = useCallback(
    (index: number) => {
      if (index === loopedSection) {
        setLooping(false);
        return;
      }
      const s = sections[index];
      setLoop({ start: s.start_bar, end: s.end_bar + 1 });
      setLooping(true);
    },
    [loopedSection, sections],
  );

  /** Turn looping on or off; with no loop yet, loop the section at the playhead. */
  const toggleLooping = useCallback(() => {
    if (looping || loop) {
      setLooping(!looping);
      return;
    }
    const index = sectionIndexAt(
      sections,
      Math.max(1, Math.floor(playheadBar)),
    );
    if (index >= 0) loopSection(index);
  }, [loop, loopSection, looping, playheadBar, sections]);

  /** Drag across the lanes to loop those bars, snapped to beats when zoomed in. */
  const selectLoop = useCallback(
    (from: number, to: number, done: boolean) => {
      const step = view.span <= GRID_MAX_SPAN ? 1 / grid.beats_per_bar : 1;
      const start = Math.max(1, snapBar(Math.min(from, to), step, Math.floor));
      const end = Math.min(
        nBars + 1,
        Math.max(start + step, snapBar(Math.max(from, to), step, Math.ceil)),
      );
      if (!done) {
        setDraftLoop({ start, end });
        return;
      }
      setDraftLoop(null);
      setLoop({ start, end });
      setLooping(true);
      setCue(Math.max(0, barStartS(grid, start)));
    },
    [grid, nBars, view.span],
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

  // Space plays from the cue and stops back to it; Shift+Space continues in place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.code !== "Space" ||
        target.closest("input, textarea, [contenteditable]")
      )
        return;
      e.preventDefault();
      if (e.shiftKey) keyActions.current.continuePlayback();
      else keyActions.current.togglePlayback();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const zoomBy = (factor: number) =>
    setBaseView((v) => {
      const span = v.span * factor;
      const center = player.position > 0 ? playheadBar : v.start + v.span / 2;
      return clampView({ start: center - span / 2, span }, nBars);
    });

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
  const cueFrac = (cueBar - view.start) / view.span;
  const showGrid = view.span <= GRID_MAX_SPAN;
  const [drumPartsOpen, setDrumPartsOpen] = useState(false);
  const [curvesOpen, setCurvesOpen] = useState(false);
  const shownLoop = draftLoop ?? loop;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
      <TrackCommands
        sectionsEdited={result.sections_edited}
        looping={looping}
        onLoop={toggleLooping}
        onResetSections={() => void reset()}
      />
      <TrackHeader source={source} result={result} onRemeasure={onRemeasure} />

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
          onClick={toggleLooping}
          className={cn(
            looping && "bg-[var(--brand-soft)] text-[var(--brand)]",
          )}
          aria-pressed={looping}
          data-testid="track-loop"
        >
          <Repeat className="size-4" />
          Loop
          {loop && (
            <span
              className={cn(
                "tabular-nums",
                !looping && "text-[var(--text-muted)]",
              )}
              data-testid="track-loop-range"
            >
              {formatBars(loop.end - loop.start)}
            </span>
          )}
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
          className="ml-auto flex items-center gap-1"
          role="group"
          aria-label="Zoom"
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => zoomBy(2)}
            disabled={view.span >= nBars}
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" />
          </Button>
          <ToggleGroup
            type="single"
            variant="outline"
            value={
              ZOOM_PRESETS.find((z) => (z.span ?? nBars) === view.span)
                ?.label ?? ""
            }
            onValueChange={(label) => {
              const preset = ZOOM_PRESETS.find((z) => z.label === label);
              if (preset) zoomTo(preset.span);
            }}
            data-testid="track-zoom"
          >
            {ZOOM_PRESETS.map((z) => (
              <ToggleGroupItem
                key={z.label}
                value={z.label}
                title={z.title}
                aria-label={z.title}
                className="h-7 px-2.5 text-xs tabular-nums data-[state=on]:bg-[var(--brand-soft)] data-[state=on]:text-[var(--brand)]"
              >
                {z.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => zoomBy(0.5)}
            disabled={view.span <= MIN_SPAN}
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" />
          </Button>
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
        className="min-h-0 shrink overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] select-none"
        data-testid="track-lanes"
      >
        <div className="relative">
          <div
            className="sticky top-0 z-10 bg-[var(--surface-2)]"
            data-testid="track-pinned-lanes"
          >
            {shownLoop && (
              <LoopBrace
                view={view}
                loop={shownLoop}
                active={looping || draftLoop !== null}
                onToggle={() => setLooping((on) => !on)}
              />
            )}
            {cueFrac >= 0 && cueFrac <= 1 && (
              <svg
                className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 text-[var(--brand)]"
                style={{
                  left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${cueFrac})`,
                }}
                width={10}
                height={7}
                aria-hidden
                data-testid="track-cue"
                data-cue-bar={cueBar}
              >
                <path d="M0 0H10L5 7Z" fill="currentColor" />
              </svg>
            )}
            <LaneRow
              label={<LaneLabel icon={RulerIcon}>Bar</LaneLabel>}
              height={36}
              view={view}
              onSeekBar={seekBar}
              onSelectBars={selectLoop}
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
                loopIndex={loopedSection}
                onChange={(next) => void persist(next)}
                onSeekBar={seekBar}
                onLoop={loopSection}
              />
            </LaneRow>
          </div>
          <LaneRow
            label={
              <ExpandToggle
                open={curvesOpen}
                onToggle={() => setCurvesOpen((open) => !open)}
                testId="track-curves-toggle"
              >
                <LaneLabel
                  icon={AudioWaveform}
                  title="Show loudness, width and brightness"
                >
                  Original
                </LaneLabel>
              </ExpandToggle>
            }
            controls={<LaneControls lane={ORIGINAL} player={player} />}
            height={96}
            view={view}
            onSeekBar={seekBar}
            onSelectBars={selectLoop}
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
          {curvesOpen && (
            <LaneRow
              label={
                <span className="pl-[22px]">
                  <CurveLegend
                    visible={curves}
                    onToggle={(id) =>
                      setCurves((c) => ({ ...c, [id]: !c[id] }))
                    }
                  />
                </span>
              }
              height={72}
              view={view}
              onSeekBar={seekBar}
              onSelectBars={selectLoop}
              testId="track-lane-curves"
            >
              <CurveLane view={view} features={features} visible={curves} />
            </LaneRow>
          )}
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
                onSelectBars={selectLoop}
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
                    onSelectBars={selectLoop}
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
          {shownLoop && (
            <LoopBand
              view={view}
              loop={shownLoop}
              active={looping || draftLoop !== null}
            />
          )}
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
        </header>
        <div className="min-h-0 flex-1 p-2">
          <SpectrumPanel
            analyser={player.analyser}
            playing={player.playing}
            clock={player.clock}
            delay={player.displayDelay}
          />
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
