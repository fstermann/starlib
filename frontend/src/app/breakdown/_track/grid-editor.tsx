"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { resetGrid, saveGrid, type Grid } from "@/lib/track-breakdown";

const NUDGES_S = [-0.01, -0.001, 0.001, 0.01];

/** Shows where bar 1 starts; lets the user correct tempo and downbeat, then re-measure. */
export function GridEditor({
  digest,
  grid,
  edited,
  onRemeasure,
}: {
  digest: string;
  grid: Grid;
  edited: boolean;
  onRemeasure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [bpm, setBpm] = useState(String(grid.bpm));
  const [downbeat, setDownbeat] = useState(grid.downbeat_s);
  const beatS = 60 / grid.bpm;

  const apply = async () => {
    const parsed = Number(bpm);
    if (!Number.isFinite(parsed) || parsed <= 40 || parsed >= 300) {
      toast.error("Tempo must be between 40 and 300 BPM");
      return;
    }
    await saveGrid(digest, parsed, Math.max(0, downbeat));
    setOpen(false);
    onRemeasure();
  };

  const reset = async () => {
    await resetGrid(digest);
    setOpen(false);
    onRemeasure();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-baseline gap-1.5 rounded-md px-1 hover:bg-[var(--surface-3)]"
          data-testid="track-grid-trigger"
        >
          <span className="text-xs text-[var(--text-muted)]">Bar 1</span>
          <span className="text-lg text-[var(--text)] tabular-nums">
            {grid.downbeat_s.toFixed(3)} s
          </span>
          <span className="text-xs text-[var(--text-subtle)]">
            {edited ? "set by hand" : "from first kick"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-[var(--text-muted)]">
            Bar 1 is assumed to start on the first kick. Correct the tempo or
            nudge the downbeat, then re-measure. Stems are reused, so this takes
            a few seconds.
          </p>
          <label className="flex items-center justify-between gap-2">
            <span className="text-[var(--text-muted)]">Tempo (BPM)</span>
            <Input
              className="w-24 tabular-nums"
              inputMode="decimal"
              value={bpm}
              onChange={(e) => setBpm(e.target.value)}
              data-testid="track-grid-bpm"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[var(--text-muted)]">
              Bar 1 at{" "}
              <span
                className="text-[var(--text)] tabular-nums"
                data-testid="track-grid-downbeat"
              >
                {downbeat.toFixed(3)} s
              </span>
            </span>
            <div className="flex flex-wrap gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDownbeat((d) => d - beatS)}
              >
                −1 beat
              </Button>
              {NUDGES_S.map((n) => (
                <Button
                  key={n}
                  variant="ghost"
                  size="sm"
                  onClick={() => setDownbeat((d) => d + n)}
                >
                  {n > 0 ? "+" : "−"}
                  {Math.abs(n * 1000)} ms
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDownbeat((d) => d + beatS)}
              >
                +1 beat
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-1">
            {edited && (
              <Button variant="ghost" size="sm" onClick={() => void reset()}>
                Use detected grid
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-[var(--brand)]"
              onClick={() => void apply()}
              data-testid="track-grid-apply"
            >
              Re-measure
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
