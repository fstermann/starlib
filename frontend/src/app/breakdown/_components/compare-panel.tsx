"use client";

import { ChevronDown, Headphones, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toggle } from "@/components/ui/toggle";
import {
  listRecentJobs,
  type JobSummary,
  type LoudnessReport,
} from "@/lib/breakdown";
import { equalisedBands, equalisedSpectrum, type BellEq } from "@/lib/eq";

import { useAbListen, type AbListen } from "../_hooks/use-ab-listen";
import { useLoudnessReports } from "../_hooks/use-loudness";

/** One colour per reference, in pick order; the set being viewed keeps the brand colour. */
const REFERENCE_COLOURS = [
  "var(--color-chart-1)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
];
const MAX_REFERENCES = REFERENCE_COLOURS.length;

function jobName(job: JobSummary | undefined): string {
  if (!job) return "Reference";
  return (
    job.title ??
    job.local_path?.split("/").pop() ??
    `SoundCloud ${job.soundcloud_id}`
  );
}

function reading(value: number | null): string {
  return value == null ? "—" : value.toFixed(1);
}

function signed(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function mean(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length
    ? known.reduce((sum, v) => sum + v, 0) / known.length
    : null;
}

function peakToLoudness(report: LoudnessReport): number | null {
  return report.true_peak_dbtp != null && report.integrated_lufs != null
    ? report.true_peak_dbtp - report.integrated_lufs
    : null;
}

function hz(value: number): string {
  return value >= 1000 ? `${value / 1000}k` : `${value}`;
}

interface Reference {
  name: string;
  colour: string;
  report: LoudnessReport;
}

interface ComparePanelProps {
  jobId: string | null;
  report: LoudnessReport | null;
  /** The preview EQ: while on, this set's tonal balance is shown as the EQ would leave it. */
  eq: BellEq;
  /** The set player's element, which the references follow for A/B listening. */
  media: HTMLMediaElement | null;
}

function withEq(report: LoudnessReport, eq: BellEq): LoudnessReport {
  if (!eq.on || !report.spectrum) return report;
  return {
    ...report,
    spectrum: equalisedSpectrum(report.spectrum, eq),
    bands: equalisedBands(report.bands, report.spectrum, eq),
  };
}

/** This set's loudness and tonal balance next to up to three other Breakdown sets. */
export function ComparePanel({ jobId, report, eq, media }: ComparePanelProps) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  // The picks belong to the set they were made on; opening another set starts empty.
  const [pick, setPick] = useState<{ jobId: string | null; ids: string[] }>();
  const referenceIds = pick?.jobId === jobId ? pick.ids : [];
  const readings = useLoudnessReports(referenceIds);
  const others = jobs.filter((j) => j.id !== jobId);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const ab = useAbListen(
    media,
    jobId ? { jobId, lufs: report?.integrated_lufs ?? null } : null,
    referenceIds.map((id) => ({
      jobId: id,
      lufs: readings.reading(id).report?.integrated_lufs ?? null,
    })),
  );

  useEffect(() => {
    listRecentJobs()
      .then((res) => setJobs(res.jobs))
      .catch((err) => console.warn("breakdown: set list failed", err));
  }, [jobId]);

  const toggle = (id: string, on: boolean) =>
    setPick({
      jobId,
      ids: on
        ? [...referenceIds, id]
        : referenceIds.filter((other) => other !== id),
    });

  const references: Reference[] = referenceIds.flatMap((id, i) => {
    const measured = readings.reading(id).report;
    return measured
      ? [
          {
            name: jobName(jobById.get(id)),
            colour: REFERENCE_COLOURS[i],
            report: measured,
          },
        ]
      : [];
  });

  return (
    <section
      className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border p-4"
      data-testid="compare-panel"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-text text-sm font-semibold">Compare</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-48 justify-between text-xs font-normal"
              disabled={others.length === 0}
              data-testid="compare-reference"
              aria-label="Sets to compare with"
            >
              {others.length === 0
                ? "No other sets"
                : referenceIds.length === 0
                  ? "Pick sets"
                  : `${referenceIds.length} of ${MAX_REFERENCES} sets`}
              <ChevronDown className="text-text-subtle size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {others.map((job) => {
              const checked = referenceIds.includes(job.id);
              return (
                <DropdownMenuCheckboxItem
                  key={job.id}
                  checked={checked}
                  disabled={!checked && referenceIds.length >= MAX_REFERENCES}
                  onCheckedChange={(on) => toggle(job.id, on)}
                  // Keep the menu open to pick several sets in a row.
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                  data-testid="compare-reference-option"
                >
                  <span className="truncate">{jobName(job)}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {referenceIds.length === 0 ? (
        <p className="text-text-subtle text-xs">
          Loudness and tonal balance of this set against up to {MAX_REFERENCES}{" "}
          other sets in Breakdown, such as an earlier master or mixes you want
          to match.
        </p>
      ) : (
        <ul
          className="flex flex-col gap-1.5 text-xs"
          data-testid="compare-sets"
        >
          <SetRow
            colour="var(--color-brand)"
            name={eq.on ? "This set with the EQ" : "This set"}
          >
            {jobId && media && (
              <Listen ab={ab} jobId={jobId} measured={report != null} />
            )}
          </SetRow>
          {referenceIds.map((id, i) => {
            const state = readings.reading(id);
            return (
              <SetRow
                key={id}
                colour={REFERENCE_COLOURS[i]}
                dashed
                name={jobName(jobById.get(id))}
                testId="compare-set"
              >
                {state.error ? (
                  <span className="text-danger truncate">{state.error}</span>
                ) : state.measuring ? (
                  <span
                    className="text-text-muted flex items-center gap-1 tabular-nums"
                    data-testid="compare-set-progress"
                  >
                    <Loader2 className="size-3.5 animate-spin" />
                    {state.progress == null
                      ? "Metering…"
                      : `Metering ${Math.round(state.progress * 100)}%`}
                  </span>
                ) : state.report ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-text-muted hover:text-text h-6"
                    onClick={() => void readings.measure(id)}
                    data-testid="compare-measure-reference"
                  >
                    Measure
                  </Button>
                )}
                {media && (
                  <Listen ab={ab} jobId={id} measured={state.report != null} />
                )}
              </SetRow>
            );
          })}
          {media && (
            <li className="text-text-subtle flex items-center gap-2 pt-1">
              <Checkbox
                id="compare-level-match"
                checked={ab.levelMatch}
                onCheckedChange={(on) => ab.setLevelMatch(on === true)}
                data-testid="compare-level-match"
              />
              <label htmlFor="compare-level-match">
                Level-match: louder sets play turned down to the quietest, so
                you compare sound, not volume.
              </label>
            </li>
          )}
        </ul>
      )}
      {references.length > 0 &&
        (report ? (
          <Comparison
            mine={withEq(report, eq)}
            before={eq.on ? report.spectrum : null}
            references={references}
          />
        ) : (
          <p className="text-text-subtle text-xs">
            Measure this set&apos;s loudness first.
          </p>
        ))}
    </section>
  );
}

function Listen({
  ab,
  jobId,
  measured,
}: {
  ab: AbListen;
  jobId: string;
  /** Unmeasured sets have no loudness to match by. */
  measured: boolean;
}) {
  const heard = ab.heard === jobId;
  const gain = ab.gainsDb.get(jobId) ?? 0;
  const matching = ab.heard != null && ab.levelMatch;
  return (
    <>
      {matching && (!measured || gain !== 0) && (
        <span
          className="text-text-subtle tabular-nums"
          data-testid="compare-listen-gain"
        >
          {measured ? `${gain.toFixed(1)} dB` : "not matched"}
        </span>
      )}
      <Toggle
        size="sm"
        pressed={heard}
        // Pressing the one being heard keeps it; switching is done from another row.
        onPressedChange={() => ab.listen(jobId)}
        className="text-text-muted hover:text-text data-[state=on]:bg-brand-soft data-[state=on]:text-brand gap-1"
        title={heard ? "Playing this one" : "Switch the sound to this set"}
        data-testid="compare-listen"
      >
        <Headphones className="size-3.5" />
        {heard ? "Hearing" : "Listen"}
      </Toggle>
    </>
  );
}

function SetRow({
  colour,
  name,
  dashed = false,
  testId,
  children,
}: {
  colour: string;
  name: string;
  dashed?: boolean;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex h-6 items-center gap-2" data-testid={testId}>
      <span
        className="w-4 shrink-0 border-t-2"
        style={{
          borderColor: colour,
          borderStyle: dashed ? "dashed" : "solid",
        }}
      />
      <span className="text-text min-w-0 flex-1 truncate">{name}</span>
      {children}
    </li>
  );
}

function Comparison({
  mine,
  before,
  references,
}: {
  mine: LoudnessReport;
  /** This set's spectrum without the EQ, drawn faintly while the EQ is on. */
  before: Spectrum | null;
  references: Reference[];
}) {
  const row = (label: string, value: (r: LoudnessReport) => number | null) => ({
    label,
    mine: value(mine),
    theirs: references.map((r) => value(r.report)),
  });
  const rows = [
    row("Integrated (LUFS)", (r) => r.integrated_lufs),
    row("Range (LU)", (r) => r.loudness_range_lu),
    row("True peak (dBTP)", (r) => r.true_peak_dbtp),
    row("Peak to loudness (dB)", peakToLoudness),
    row("Short-term max (LUFS)", (r) => r.short_term_max_lufs),
  ];
  const bands = mine.bands.map((band) =>
    row(
      `${band.name} ${hz(band.low_hz)}–${hz(band.high_hz)}`,
      (r) => r.bands.find((b) => b.name === band.name)?.level_db ?? null,
    ),
  );
  const spectra = references.flatMap((r) =>
    r.report.spectrum ? [{ ...r, spectrum: r.report.spectrum }] : [],
  );

  return (
    <>
      <div className="border-border border-t pt-3">
        <CompareTable
          testId="compare-readings"
          title={before ? "Loudness, without the EQ" : "Loudness"}
          rows={rows}
          references={references}
        />
      </div>
      <div className="border-border border-t pt-3">
        <CompareTable
          testId="compare-bands"
          title="Tonal balance: each band's share of the set, in dB"
          rows={bands}
          references={references}
        />
      </div>
      {mine.spectrum && spectra.length > 0 && (
        <SpectrumChart
          mine={mine.spectrum}
          before={before}
          references={spectra}
        />
      )}
    </>
  );
}

interface CompareRow {
  label: string;
  mine: number | null;
  theirs: Array<number | null>;
}

function CompareTable({
  title,
  rows,
  references,
  testId,
}: {
  title: string;
  rows: CompareRow[];
  references: Reference[];
  testId: string;
}) {
  const several = references.length > 1;
  return (
    <table className="w-full text-sm tabular-nums" data-testid={testId}>
      <caption className="text-text-muted pb-1.5 text-left text-xs">
        {title}
      </caption>
      <thead>
        <tr className="text-text-subtle text-xs">
          <th className="text-left font-normal" />
          <th className="w-12 text-right font-normal">This</th>
          {references.map((r, i) => (
            <th key={r.name + i} className="w-12 text-right font-normal">
              {several ? (
                <span
                  className="inline-block w-4 border-t-2 border-dashed align-middle"
                  style={{ borderColor: r.colour }}
                  aria-label={r.name}
                />
              ) : (
                "Ref"
              )}
            </th>
          ))}
          <th
            className="w-12 text-right font-normal"
            title={
              several
                ? "This set minus the references' average"
                : "This set minus the reference"
            }
          >
            Diff
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const target = mean(row.theirs);
          return (
            <tr key={row.label} data-testid={`${testId}-row`}>
              <td className="text-text-muted truncate py-0.5">{row.label}</td>
              <td className="text-text text-right">{reading(row.mine)}</td>
              {row.theirs.map((value, i) => (
                <td key={i} className="text-text-muted text-right">
                  {reading(value)}
                </td>
              ))}
              <td
                className="text-text text-right font-semibold"
                data-testid={`${testId}-diff`}
              >
                {signed(
                  row.mine != null && target != null ? row.mine - target : null,
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type Spectrum = NonNullable<LoudnessReport["spectrum"]>;

const CHART_W = 300;
const CHART_H = 120;
const LOW_HZ = 20;
const HIGH_HZ = 20000;
const GRID_HZ = [100, 1000, 10000];
// Below this much under the loudest point the curves are noise floor, not balance.
const CHART_RANGE_DB = 48;

function SpectrumChart({
  mine,
  before,
  references,
}: {
  mine: Spectrum;
  before: Spectrum | null;
  references: Array<Reference & { spectrum: Spectrum }>;
}) {
  const all = [mine, ...references.map((r) => r.spectrum)].flatMap(
    (s) => s.level_db,
  );
  const top = Math.ceil(Math.max(...all) + 2);
  const bottom = Math.max(
    Math.floor(Math.min(...all) - 2),
    top - CHART_RANGE_DB,
  );
  const x = (f: number) =>
    (Math.log10(f / LOW_HZ) / Math.log10(HIGH_HZ / LOW_HZ)) * CHART_W;
  const y = (db: number) =>
    ((top - Math.max(db, bottom)) / (top - bottom)) * CHART_H;
  const path = (s: Spectrum) =>
    s.centres_hz
      .map(
        (f, i) =>
          `${i ? "L" : "M"}${x(f).toFixed(1)},${y(s.level_db[i]).toFixed(1)}`,
      )
      .join("");

  return (
    <div
      className="border-border flex flex-col gap-1.5 border-t pt-3"
      data-testid="compare-spectrum"
    >
      <h3 className="text-text-muted text-xs">Spectrum, 1/6 octave</h3>
      <div className="relative h-32">
        <svg
          className="absolute inset-0"
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label="Average spectrum of this set and the references"
        >
          {GRID_HZ.map((f) => (
            <line
              key={f}
              x1={x(f)}
              x2={x(f)}
              y1={0}
              y2={CHART_H}
              stroke="var(--color-border)"
              opacity={0.6}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {references.map((r, i) => (
            <path
              key={r.name + i}
              d={path(r.spectrum)}
              stroke={r.colour}
              strokeWidth={1.4}
              strokeDasharray="4 3"
              fill="none"
              vectorEffect="non-scaling-stroke"
              data-testid="compare-spectrum-reference"
            />
          ))}
          {before && (
            <path
              d={path(before)}
              stroke="var(--color-brand)"
              strokeWidth={1.2}
              opacity={0.35}
              fill="none"
              vectorEffect="non-scaling-stroke"
              data-testid="compare-spectrum-before-eq"
            />
          )}
          <path
            d={path(mine)}
            stroke="var(--color-brand)"
            strokeWidth={1.6}
            fill="none"
            vectorEffect="non-scaling-stroke"
            data-testid="compare-spectrum-mine"
          />
        </svg>
        {GRID_HZ.map((f) => (
          <span
            key={f}
            className="text-text-subtle absolute bottom-0 -translate-x-1/2 text-[10px] tabular-nums"
            style={{ left: `${(x(f) / CHART_W) * 100}%` }}
          >
            {hz(f)}
          </span>
        ))}
        <span className="text-text-subtle absolute top-0 left-0 text-[10px] tabular-nums">
          {top} dB
        </span>
      </div>
    </div>
  );
}
