"use client";

import * as React from "react";

import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export interface RangeSliderFieldProps {
  min: number;
  max: number;
  step?: number;
  /** Committed value. null means "unset" on that end. */
  value: [number | null, number | null];
  onCommit: (value: [number, number]) => void;
  format?: (n: number) => string;
  className?: string;
}

/**
 * Range slider with committed min/max semantics and live labels while
 * dragging. Lifts the pattern from collection-filter-bar.tsx BPM block.
 */
export function RangeSliderField({
  min,
  max,
  step = 1,
  value,
  onCommit,
  format = (n) => String(n),
  className,
}: RangeSliderFieldProps) {
  const resolved: [number, number] = [value[0] ?? min, value[1] ?? max];
  const [live, setLive] = React.useState<[number, number]>(resolved);

  React.useEffect(() => {
    setLive(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value[0], value[1], min, max]);

  return (
    <div className={cn("flex w-full items-center gap-2", className)}>
      <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
        {format(live[0])}
      </span>
      <Slider
        min={min}
        max={max}
        step={step}
        value={live}
        onValueChange={(v) => setLive([v[0], v[1]])}
        onValueCommit={(v) => onCommit([v[0], v[1]])}
        className="flex-1"
      />
      <span className="text-muted-foreground w-10 shrink-0 text-xs tabular-nums">
        {format(live[1])}
      </span>
    </div>
  );
}
