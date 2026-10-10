"use client";

import { Button } from "@/components/ui/button";

const STAGES: { id: string; label: string }[] = [
  { id: "hash", label: "Reading audio" },
  { id: "stems", label: "Separating stems" },
  { id: "mix", label: "Measuring mix" },
  { id: "drums", label: "Measuring drums" },
  { id: "bass", label: "Measuring bass" },
  { id: "other", label: "Measuring other" },
  { id: "vocals", label: "Measuring vocals / FX" },
];

/** Stage list for a running analysis; stem separation dominates the wait. */
export function TrackProgress({
  stage,
  progress,
  onCancel,
}: {
  stage: string | null;
  progress: number | null;
  onCancel: () => void;
}) {
  const current = STAGES.findIndex((s) => s.id === stage);
  return (
    <div
      className="flex w-80 flex-col gap-3"
      data-testid="track-breakdown-progress"
    >
      <h2 className="text-xl text-[var(--text)]">Analysing track</h2>
      <ol className="flex flex-col gap-1.5 text-sm">
        {STAGES.map((s, i) => (
          <li
            key={s.id}
            className={
              i === current
                ? "text-[var(--text)]"
                : i < current
                  ? "text-[var(--text-muted)]"
                  : "text-[var(--text-subtle)]"
            }
          >
            <div className="flex justify-between gap-2">
              <span>{s.label}</span>
              {i === current && s.id === "stems" && progress != null && (
                <span
                  className="tabular-nums"
                  data-testid="track-stems-percent"
                >
                  {Math.round(progress * 100)}%
                </span>
              )}
            </div>
            {i === current && s.id === "stems" && progress != null && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className="h-full bg-[var(--brand)] transition-[width] duration-200"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="text-xs text-[var(--text-muted)]">
        First runs separate stems, which takes about half a minute per track on
        Apple Silicon. Results are cached.
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={onCancel}
        data-testid="track-breakdown-cancel"
      >
        Cancel
      </Button>
    </div>
  );
}
