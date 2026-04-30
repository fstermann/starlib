"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/** Pure scrub math, exported for unit tests. */
export interface ScrubMathInput {
  startValue: number;
  dx: number;
  pxPerUnit: number;
  min?: number;
  max?: number;
}

export function scrubValue({
  startValue,
  dx,
  pxPerUnit,
  min,
  max,
}: ScrubMathInput): number {
  const next = startValue + Math.round(dx / pxPerUnit);
  let clamped = next;
  if (typeof min === "number") clamped = Math.max(min, clamped);
  if (typeof max === "number") clamped = Math.min(max, clamped);
  return clamped;
}

export interface ScrubNumberInputProps {
  /** Stringly-typed so the field can be empty ("") between edits. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  /** Min scrub value — typing can still go anywhere. */
  min?: number;
  max?: number;
  /** Default pixels per integer step while scrubbing. Shift halves it (faster). */
  pxPerUnit?: number;
  ariaLabel?: string;
  /** Distinguish multiple instances in tests. */
  testId?: string;
}

/**
 * Numeric input you can drag horizontally to scrub. Click without dragging
 * still focuses for direct typing. Keeps integer steps. Native spinner arrows
 * are hidden — drag is the affordance.
 */
export function ScrubNumberInput({
  value,
  onChange,
  placeholder,
  className,
  min,
  max,
  pxPerUnit = 4,
  ariaLabel,
  testId,
}: ScrubNumberInputProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const dragRef = React.useRef<{
    startX: number;
    startValue: number;
    active: boolean;
    pointerId: number;
  } | null>(null);
  const [scrubbing, setScrubbing] = React.useState(false);

  function handlePointerDown(e: React.PointerEvent<HTMLInputElement>) {
    if (e.button !== 0) return;
    // Don't hijack typing: if the input already has focus, behave like a normal
    // click that places the caret.
    if (document.activeElement === inputRef.current) return;
    e.preventDefault();
    const startValue = parseInt(value || "0", 10) || 0;
    dragRef.current = {
      startX: e.clientX,
      startValue,
      active: false,
      pointerId: e.pointerId,
    };
    inputRef.current?.setPointerCapture?.(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.active) {
      if (Math.abs(dx) < 3) return;
      drag.active = true;
      setScrubbing(true);
    }
    const next = scrubValue({
      startValue: drag.startValue,
      dx,
      pxPerUnit: e.shiftKey ? pxPerUnit * 4 : pxPerUnit,
      min,
      max,
    });
    onChange(String(next));
  }

  function handlePointerUp(_e: React.PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const wasDrag = drag.active;
    dragRef.current = null;
    setScrubbing(false);
    inputRef.current?.releasePointerCapture?.(drag.pointerId);
    if (!wasDrag) inputRef.current?.focus();
  }

  return (
    <input
      ref={inputRef}
      type="number"
      inputMode="numeric"
      step={1}
      data-slot="input"
      data-testid={testId}
      data-scrubbing={scrubbing ? "true" : undefined}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      placeholder={placeholder}
      className={cn(
        "border-input bg-card dark:bg-muted text-foreground h-7 w-full min-w-0 rounded-md border px-2.5 text-xs transition-[color,box-shadow,border-color] outline-none",
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        // Hide the native spinner — drag is the scrub affordance.
        "[appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:hidden",
        scrubbing
          ? "cursor-ew-resize select-none"
          : "cursor-ew-resize focus:cursor-text",
        className,
      )}
    />
  );
}
