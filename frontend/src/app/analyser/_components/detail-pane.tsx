"use client";

import { Button } from "@/components/ui/button";
import { formatTimecode } from "@/lib/analyser";

import type { AnalyserUiState } from "../_state";

interface DetailPaneProps {
  state: AnalyserUiState;
  onReanalyse: (range: { start_s: number; end_s: number }) => void;
  onClearSelection: () => void;
}

export function AnalyserDetailPane({
  state,
  onReanalyse,
  onClearSelection,
}: DetailPaneProps) {
  if (!state.selection) {
    return (
      <aside
        className="border-border bg-surface-2 text-text-muted rounded-lg border p-4 text-sm"
        data-testid="detail-empty"
      >
        Drag a range on the timeline to inspect or re-analyse a region.
      </aside>
    );
  }

  const { start_s, end_s } = state.selection;
  const inRange = state.windows.filter(
    (w) => w.start_s >= start_s - 0.5 && w.end_s <= end_s + 0.5,
  );
  const bpms = inRange.map((w) => w.bpm).filter((b) => b > 0);
  const median = bpms.length
    ? bpms.sort((a, b) => a - b)[Math.floor(bpms.length / 2)]
    : null;
  const sectionsInRange = state.sections.filter(
    (s) => s.start_s < end_s && s.end_s > start_s,
  );
  const matchedTracks = sectionsInRange
    .map((s) => state.tracks.get(s.section_index))
    .filter(Boolean);

  return (
    <aside
      className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border p-4"
      data-testid="detail-pane"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-text font-semibold">
          {formatTimecode(start_s)} – {formatTimecode(end_s)}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClearSelection}>
          Clear
        </Button>
      </header>
      <dl className="text-text-muted grid grid-cols-2 gap-y-1 text-sm">
        <dt>Median BPM</dt>
        <dd className="text-text">
          {median != null ? median.toFixed(1) : "—"}
        </dd>
        <dt>Windows</dt>
        <dd className="text-text">{inRange.length}</dd>
        <dt>Sections</dt>
        <dd className="text-text">{sectionsInRange.length}</dd>
      </dl>
      {matchedTracks.length > 0 && (
        <ul className="text-text-muted space-y-1 text-xs">
          {matchedTracks.map((t) =>
            t ? (
              <li key={t.section_index}>
                <span className="text-text font-medium">{t.title}</span> —{" "}
                {t.artist} ({Math.round(t.confidence * 100)}%)
              </li>
            ) : null,
          )}
        </ul>
      )}
      <Button
        size="sm"
        onClick={() => onReanalyse({ start_s, end_s })}
        data-testid="detail-reanalyse"
      >
        Re-analyse this region
      </Button>
    </aside>
  );
}
