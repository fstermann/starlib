"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTimecode } from "@/lib/breakdown";
import { cn } from "@/lib/utils";

import {
  peakOvers,
  TRUE_PEAK_CEILING_DBTP,
  type Loudness,
} from "../_hooks/use-loudness";
import type { BreakdownUiState } from "../_state";

const NO_TRACKLIST =
  "Needs a tracklist: import a CUE sheet or run a Shazam scan.";

function level(value: number | null, unit: string): string {
  return value == null ? "—" : `${value.toFixed(1)} ${unit}`;
}

function signedDb(value: number, unit = "dB"): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} ${unit}`;
}

interface LoudnessPanelProps {
  state: BreakdownUiState;
  loudness: Loudness;
  onSeek: (seconds: number) => void;
}

/** EBU R128 loudness of the set: overall readings, gain to a target, and where the mix is uneven. */
export function LoudnessPanel({ state, loudness, onSeek }: LoudnessPanelProps) {
  const { report, measuring, progress, error, measure, target, setTarget } =
    loudness;
  const gain = loudness.gainDb;
  const peakAfterGain =
    gain != null && report?.true_peak_dbtp != null
      ? report.true_peak_dbtp + gain
      : null;
  const secondsOver = report
    ? peakOvers(report, gain ?? 0).length * report.curve.step_s
    : 0;
  const reference = report?.reference_lufs ?? null;
  const hasTracklist = reference != null;
  const suggestions = report?.segments.filter(
    (s) => s.suggested_gain_db != null,
  );
  const jumps = report?.transitions.filter(
    (t) => Math.abs(t.jump_lu) >= report.transition_jump_lu,
  );
  const lowEndRef = report?.low_end_reference_lu ?? null;
  const lowEndOff =
    report && lowEndRef != null
      ? report.segments.filter(
          (s) =>
            s.low_end_lu != null &&
            Math.abs(s.low_end_lu - lowEndRef) >= report.low_end_tolerance_lu,
        )
      : [];

  return (
    <section
      className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border p-4"
      data-testid="loudness-panel"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-text text-sm font-semibold">Loudness</h2>
        {!report && (
          <Button
            variant="ghost"
            size="sm"
            className="text-text-muted hover:text-text gap-1.5"
            onClick={() => void measure()}
            disabled={measuring || !state.meta.durationS}
            data-testid="loudness-measure"
          >
            {measuring && <Loader2 className="size-4 animate-spin" />}
            {measuring ? "Measuring…" : "Measure"}
          </Button>
        )}
      </header>
      {error && <p className="text-danger text-xs">{error}</p>}
      {!report && measuring ? (
        <MeasureProgress progress={progress} />
      ) : !report ? (
        <p className="text-text-subtle text-xs">
          Integrated loudness, range and true peak (EBU R128), and the input
          gain to reach a target.
        </p>
      ) : (
        <>
          <dl
            className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm"
            data-testid="loudness-summary"
          >
            <Reading
              label="Integrated"
              value={level(report.integrated_lufs, "LUFS")}
              testId="loudness-integrated"
            />
            <Reading
              label="Range (LRA)"
              value={level(report.loudness_range_lu, "LU")}
            />
            <Reading
              label="Short-term max"
              value={level(report.short_term_max_lufs, "LUFS")}
              testId="loudness-short-term-max"
            />
            <Reading
              label="Short-term min"
              value={level(report.short_term_min_lufs, "LUFS")}
              testId="loudness-short-term-min"
            />
            <Reading
              label="Momentary max"
              value={level(report.momentary_max_lufs, "LUFS")}
            />
            <Reading
              label="True peak"
              value={level(report.true_peak_dbtp, "dBTP")}
              testId="loudness-true-peak"
            />
          </dl>
          <div className="border-border flex flex-col gap-1.5 border-t pt-3">
            <label className="text-text-muted flex items-center gap-2 text-sm">
              Target
              <Input
                type="number"
                step="0.5"
                inputMode="decimal"
                placeholder="-9"
                className="h-7 w-20 tabular-nums"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                data-testid="loudness-target"
                aria-label="Target integrated loudness in LUFS"
              />
              LUFS
            </label>
            {gain != null && (
              <p className="text-text text-sm" data-testid="loudness-gain">
                Input gain{" "}
                <span className="font-semibold tabular-nums">
                  {signedDb(gain)}
                </span>
                {peakAfterGain != null && (
                  <span className="text-text-muted">
                    {" "}
                    · true peak after{" "}
                    <span
                      className={cn(
                        "tabular-nums",
                        peakAfterGain > 0 && "text-danger",
                      )}
                      data-testid="loudness-peak-after-gain"
                    >
                      {level(peakAfterGain, "dBTP")}
                    </span>
                  </span>
                )}
              </p>
            )}
            <p
              className="text-text-subtle text-xs"
              data-testid="loudness-peak-overs"
            >
              {secondsOver > 0
                ? `${formatTimecode(secondsOver)} above ${TRUE_PEAK_CEILING_DBTP} dBTP${gain != null ? " after the gain" : ""}, marked red on the LUFS chart: a limiter would act there.`
                : `True peak stays under ${TRUE_PEAK_CEILING_DBTP} dBTP${gain != null ? " after the gain" : ""}.`}
            </p>
          </div>
          <Findings
            testId="loudness-even-out"
            title={
              reference != null
                ? `Even out: tracks against the median (${reference.toFixed(1)} LUFS), beyond ±${report.tolerance_lu} LU`
                : "Even out"
            }
            empty={
              hasTracklist
                ? `Every track is within ±${report.tolerance_lu} LU of the median.`
                : NO_TRACKLIST
            }
          >
            {suggestions?.map((s) => (
              <FindingRow
                key={s.start_s}
                at={s.start_s}
                range={`${formatTimecode(s.start_s)}–${formatTimecode(s.end_s)}`}
                label={s.label}
                detail={s.integrated_lufs.toFixed(1)}
                value={signedDb(s.suggested_gain_db ?? 0)}
                testId="loudness-suggestion"
                valueTestId="loudness-suggestion-gain"
                onSeek={onSeek}
              />
            ))}
          </Findings>
          <Findings
            testId="loudness-transitions"
            title={
              hasTracklist
                ? `Transitions: ${report.transition_window_s} s either side of each change, jumps of ${report.transition_jump_lu} LU or more`
                : "Transitions"
            }
            empty={
              hasTracklist
                ? `No change jumps by ${report.transition_jump_lu} LU or more.`
                : NO_TRACKLIST
            }
          >
            {jumps?.map((t) => (
              <FindingRow
                key={t.at_s}
                at={t.at_s}
                range={formatTimecode(t.at_s)}
                label={`${t.from_label} → ${t.to_label}`}
                detail={`${t.before_lufs.toFixed(1)} → ${t.after_lufs.toFixed(1)}`}
                value={signedDb(t.jump_lu, "LU")}
                testId="loudness-transition"
                valueTestId="loudness-transition-jump"
                onSeek={onSeek}
              />
            ))}
          </Findings>
          <Findings
            testId="loudness-low-end"
            title={
              lowEndRef != null
                ? `Low end: bass below 150 Hz against the median track, beyond ±${report.low_end_tolerance_lu} LU`
                : "Low end"
            }
            empty={
              lowEndRef != null
                ? `Every track's bass is within ±${report.low_end_tolerance_lu} LU of the median.`
                : NO_TRACKLIST
            }
          >
            {lowEndOff.map((s) => {
              const offset = (s.low_end_lu ?? 0) - (lowEndRef ?? 0);
              return (
                <FindingRow
                  key={s.start_s}
                  at={s.start_s}
                  range={`${formatTimecode(s.start_s)}–${formatTimecode(s.end_s)}`}
                  label={s.label}
                  detail={offset > 0 ? "more bass" : "less bass"}
                  value={signedDb(offset, "LU")}
                  testId="loudness-low-end-row"
                  valueTestId="loudness-low-end-offset"
                  onSeek={onSeek}
                />
              );
            })}
          </Findings>
        </>
      )}
    </section>
  );
}

/** Where each meter pass starts, as a fraction of the whole measurement. */
const MEASURE_PHASES = [
  { from: 0, label: "full band" },
  { from: 0.7, label: "low band" },
  { from: 0.85, label: "spectrum" },
];

function MeasureProgress({ progress }: { progress: number | null }) {
  const phase = MEASURE_PHASES.findLast((p) => (progress ?? 0) >= p.from);
  const percent = progress == null ? null : Math.round(progress * 100);
  return (
    <div className="flex w-full flex-col gap-1" data-testid="loudness-progress">
      <div className="text-text-muted flex items-center justify-between text-xs tabular-nums">
        <span>
          <span className="text-text font-medium">Metering the set</span>
          <span className="text-text-subtle"> · {phase?.label}</span>
        </span>
        <span data-testid="loudness-progress-percent">
          {percent == null ? "…" : `${percent}%`}
        </span>
      </div>
      <div
        className="bg-surface-3 relative h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label="Metering the set"
      >
        {percent == null ? (
          <div className="bg-brand/60 absolute inset-y-0 left-0 w-1/4 animate-pulse" />
        ) : (
          <div
            className="bg-brand absolute inset-y-0 left-0 transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** A titled list of places in the set to look at, or a note when there are none. */
function Findings({
  title,
  empty,
  testId,
  children,
}: {
  title: string;
  empty: string;
  testId: string;
  children: ReactNode[] | undefined;
}) {
  return (
    <div
      className="border-border flex flex-col gap-1.5 border-t pt-3"
      data-testid={testId}
    >
      <h3 className="text-text-muted text-xs">{title}</h3>
      {children && children.length > 0 ? (
        <ul className="divide-border -mx-1 divide-y">{children}</ul>
      ) : (
        <p className="text-text-subtle text-xs">{empty}</p>
      )}
    </div>
  );
}

function Reading({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function FindingRow({
  at,
  range,
  label,
  detail,
  value,
  testId,
  valueTestId,
  onSeek,
}: {
  at: number;
  range: string;
  label: string;
  detail: string;
  value: string;
  testId: string;
  valueTestId: string;
  onSeek: (seconds: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="hover:bg-surface-3 flex w-full items-baseline gap-2 rounded-md px-1 py-1.5 text-left text-sm"
        onClick={() => onSeek(at)}
        title="Jump here"
        data-testid={testId}
      >
        <span className="text-text-subtle shrink-0 tabular-nums">{range}</span>
        <span className="text-text min-w-0 flex-1 truncate">{label}</span>
        <span className="text-text-muted shrink-0 tabular-nums">{detail}</span>
        <span
          className="text-text w-16 shrink-0 text-right font-semibold tabular-nums"
          data-testid={valueTestId}
        >
          {value}
        </span>
      </button>
    </li>
  );
}
