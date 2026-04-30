"use client";

import { Loader2 } from "lucide-react";

import { formatTimecode } from "@/lib/analyser";
import { cn } from "@/lib/utils";

import type { AnalyserUiState } from "../_state";

interface HeaderProps {
  state: AnalyserUiState;
}

const STATUS_LABEL: Record<AnalyserUiState["status"], string> = {
  idle: "Ready",
  loading: "Loading",
  pending: "Queued",
  running: "Analysing",
  complete: "Complete",
  error: "Error",
};

export function AnalyserHeader({ state }: HeaderProps) {
  const isRunning = state.status === "running";
  return (
    <header
      className="border-border bg-surface-2 flex flex-wrap items-end justify-between gap-3 rounded-lg border px-4 py-3"
      data-testid="analyser-header"
    >
      <div>
        <div className="text-text-subtle text-[11px] tracking-wider uppercase">
          Set
        </div>
        <div className="text-text text-lg font-semibold">
          {state.meta.title ?? "(untitled set)"}
        </div>
        <div className="text-text-muted text-sm">
          {state.meta.artist ?? "(unknown artist)"} ·{" "}
          {state.meta.durationS > 0
            ? formatTimecode(state.meta.durationS)
            : "—"}
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        {isRunning && (
          <Loader2
            className="text-brand size-4 animate-spin"
            data-testid="analysing-spinner"
          />
        )}
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            state.status === "error"
              ? "bg-destructive/10 text-destructive"
              : state.status === "complete"
                ? "bg-brand-soft text-text"
                : "bg-surface-3 text-text-muted",
          )}
          data-testid="analyser-status"
        >
          {STATUS_LABEL[state.status]}
        </span>
      </div>
      {state.errorMessage && (
        <div className="bg-destructive/10 text-destructive w-full rounded p-2 text-xs">
          {state.errorMessage}
        </div>
      )}
    </header>
  );
}
