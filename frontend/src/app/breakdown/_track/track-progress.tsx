"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { STEM_COLORS, STEM_NAMES, type StemName } from "@/lib/track-breakdown";
import { cn } from "@/lib/utils";

const SOURCES = ["mix", ...STEM_NAMES] as const;
type Source = (typeof SOURCES)[number];

const SOURCE_LABELS: Record<Source, string> = {
  mix: "Mix",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
  vocals: "Vocals / FX",
};

const MIX_COLOR = "var(--text-muted)";

type StepState = "done" | "current" | "pending";

function stepState(index: number, current: number): StepState {
  if (index < current) return "done";
  return index === current ? "current" : "pending";
}

function sourceColor(source: Source): string {
  return source === "mix" ? MIX_COLOR : STEM_COLORS[source as StemName];
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Analysis progress: read, separate into stems, split the drums, then measure each source. */
export function TrackProgress({
  title,
  stage,
  progress,
  onCancel,
}: {
  title: string;
  stage: string | null;
  progress: number | null;
  onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const measuring = SOURCES.indexOf(stage as Source);
  const step =
    stage === "hash"
      ? 0
      : stage === "stems"
        ? 1
        : stage === "drum_parts"
          ? 2
          : measuring >= 0
            ? 3
            : -1;

  return (
    <section
      className="flex w-full max-w-[440px] flex-col gap-5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-6"
      data-testid="track-breakdown-progress"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-[var(--text-muted)]">Analysing</p>
          <h2 className="line-clamp-2 text-base font-medium text-[var(--text)]">
            {title}
          </h2>
        </div>
        <span
          className="shrink-0 font-mono text-xs text-[var(--text-subtle)] tabular-nums"
          aria-label="Elapsed time"
        >
          {formatElapsed(elapsed)}
        </span>
      </header>

      <ol className="flex flex-col">
        <Step state={stepState(0, step)} label="Reading audio" />
        <Step
          state={stepState(1, step)}
          label="Separating stems"
          detail={
            step === 1 && progress != null ? (
              <span data-testid="track-stems-percent">
                {Math.round(progress * 100)}%
              </span>
            ) : null
          }
        >
          <ul className="flex flex-col gap-1.5 pt-2">
            {STEM_NAMES.map((stem) => (
              <li key={stem} className="flex items-center gap-2">
                <span className="w-16 text-xs text-[var(--text-muted)]">
                  {SOURCE_LABELS[stem]}
                </span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                  <span
                    className="block h-full rounded-full transition-[width] duration-200 ease-[var(--ease-standard)]"
                    style={{
                      width: `${(step > 1 ? 1 : step === 1 ? (progress ?? 0) : 0) * 100}%`,
                      background: STEM_COLORS[stem],
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </Step>
        <Step
          state={stepState(2, step)}
          label="Splitting drums"
          detail={
            step === 2 && progress != null ? (
              <span data-testid="track-drums-percent">
                {Math.round(progress * 100)}%
              </span>
            ) : null
          }
        />
        <Step state={stepState(3, step)} label="Measuring bars" last>
          <ul className="flex flex-wrap gap-1.5 pt-2">
            {SOURCES.map((source, i) => {
              const state = step < 3 ? "pending" : stepState(i, measuring);
              return (
                <li
                  key={source}
                  className={cn(
                    "flex h-6 items-center gap-1.5 rounded-sm border border-[var(--border)] px-2 text-xs",
                    state === "pending"
                      ? "text-[var(--text-subtle)]"
                      : "text-[var(--text)]",
                  )}
                  data-state={state}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      state === "current" && "animate-pulse",
                    )}
                    style={{
                      background:
                        state === "pending"
                          ? "var(--border-strong)"
                          : sourceColor(source),
                    }}
                  />
                  {SOURCE_LABELS[source]}
                </li>
              );
            })}
          </ul>
        </Step>
      </ol>

      <footer className="flex items-end justify-between gap-4 border-t border-[var(--border)] pt-4">
        <p className="text-xs text-[var(--text-muted)]">
          The first run separates stems and drums, about a minute on Apple
          Silicon. Results are cached.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
          data-testid="track-breakdown-cancel"
        >
          Cancel
        </Button>
      </footer>
    </section>
  );
}

function Step({
  state,
  label,
  detail,
  last = false,
  children,
}: {
  state: StepState;
  label: string;
  detail?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[20px_1fr] gap-x-3" data-state={state}>
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border",
            state === "done" &&
              "border-[var(--border)] bg-[var(--surface-3)] text-[var(--text-muted)]",
            state === "current" &&
              "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]",
            state === "pending" && "border-[var(--border)]",
          )}
        >
          {state === "done" && <Check className="size-3" />}
          {state === "current" && <Loader2 className="size-3 animate-spin" />}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-[var(--border)]" />}
      </div>
      <div className={cn("min-w-0", !last && "pb-4")}>
        <div className="flex h-5 items-center justify-between gap-2 text-sm">
          <span
            className={
              state === "pending"
                ? "text-[var(--text-subtle)]"
                : state === "current"
                  ? "text-[var(--text)]"
                  : "text-[var(--text-muted)]"
            }
          >
            {label}
          </span>
          {detail && (
            <span className="font-mono text-xs text-[var(--text)] tabular-nums">
              {detail}
            </span>
          )}
        </div>
        {children}
      </div>
    </li>
  );
}
