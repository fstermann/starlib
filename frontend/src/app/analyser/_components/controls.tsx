"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AnalyserJobOptions } from "@/lib/analyser";

interface ControlsProps {
  options: AnalyserJobOptions;
  onChange: (next: AnalyserJobOptions) => void;
  onReanalyseAll: () => void;
  reanalyseDisabled: boolean;
}

export function AnalyserControls({
  options,
  onChange,
  onReanalyseAll,
  reanalyseDisabled,
}: ControlsProps) {
  const [bpmLo, setBpmLo] = useState(options.bpm_range?.[0]?.toString() ?? "");
  const [bpmHi, setBpmHi] = useState(options.bpm_range?.[1]?.toString() ?? "");
  const [target, setTarget] = useState(options.target_bpm?.toString() ?? "");

  const commit = (next: AnalyserJobOptions) => onChange(next);

  return (
    <section
      className="border-border bg-surface-2 flex flex-wrap items-end gap-4 rounded-lg border px-4 py-3"
      data-testid="analyser-controls"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="target-bpm">Target BPM</Label>
        <Input
          id="target-bpm"
          type="number"
          min={60}
          max={200}
          className="w-24"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onBlur={() =>
            commit({
              ...options,
              target_bpm: target ? Number(target) : null,
            })
          }
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label>BPM range</Label>
        <div className="flex items-center gap-2">
          <Input
            aria-label="BPM range minimum"
            type="number"
            min={60}
            max={200}
            className="w-20"
            value={bpmLo}
            onChange={(e) => setBpmLo(e.target.value)}
            onBlur={() =>
              commit({
                ...options,
                bpm_range:
                  bpmLo && bpmHi ? [Number(bpmLo), Number(bpmHi)] : null,
              })
            }
          />
          <span className="text-text-subtle">–</span>
          <Input
            aria-label="BPM range maximum"
            type="number"
            min={60}
            max={200}
            className="w-20"
            value={bpmHi}
            onChange={(e) => setBpmHi(e.target.value)}
            onBlur={() =>
              commit({
                ...options,
                bpm_range:
                  bpmLo && bpmHi ? [Number(bpmLo), Number(bpmHi)] : null,
              })
            }
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pitch-strategy">Pitch strategy</Label>
        <Select
          value={options.pitch_strategy}
          onValueChange={(v) =>
            commit({
              ...options,
              pitch_strategy: v as AnalyserJobOptions["pitch_strategy"],
            })
          }
        >
          <SelectTrigger id="pitch-strategy" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="single">Single</SelectItem>
            <SelectItem value="range">Range</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="window-s">Window (s)</Label>
        <Input
          id="window-s"
          type="number"
          min={5}
          max={120}
          className="w-20"
          value={options.window_s}
          onChange={(e) =>
            commit({ ...options, window_s: Number(e.target.value) })
          }
        />
      </div>
      <div className="ml-auto">
        <Button
          variant="secondary"
          size="sm"
          disabled={reanalyseDisabled}
          onClick={onReanalyseAll}
          data-testid="reanalyse-all"
        >
          Re-analyse all
        </Button>
      </div>
    </section>
  );
}
