"use client";

import { MinusIcon, PlusIcon } from "lucide-react";
import { Button, Group, Input, NumberField } from "react-aria-components";

import { cn } from "@/lib/utils";

export interface NumberInputProps {
  /** Stringly-typed so the field can be empty ("") between edits. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  min?: number;
  max?: number;
  ariaLabel?: string;
  /** Distinguish multiple instances in tests. */
  testId?: string;
}

/**
 * Integer number input with -/+ buttons. Wraps react-aria-components'
 * NumberField; exposes a string `value` so callers can keep the field empty.
 */
export function NumberInput({
  value,
  onChange,
  placeholder,
  className,
  min,
  max,
  ariaLabel,
  testId,
}: NumberInputProps) {
  const numericValue = value === "" ? NaN : Number(value);

  return (
    <NumberField
      value={numericValue}
      onChange={(n) => onChange(Number.isNaN(n) ? "" : String(n))}
      minValue={min}
      maxValue={max}
      step={1}
      formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
      aria-label={ariaLabel}
    >
      <Group
        className={cn(
          "border-input bg-card dark:bg-muted relative inline-flex h-8 w-full min-w-0 items-center overflow-hidden rounded-md border text-xs transition-[color,box-shadow,border-color] outline-none",
          "data-focus-within:border-ring data-focus-within:ring-ring/50 data-focus-within:ring-[3px]",
          "data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
          className,
        )}
      >
        <Input
          data-testid={testId}
          data-slot="input"
          placeholder={placeholder}
          className="placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground w-full min-w-0 grow bg-transparent px-2.5 tabular-nums outline-none"
        />
        <Button
          slot="decrement"
          className="border-input text-muted-foreground hover:bg-accent hover:text-foreground mr-1 flex aspect-square h-5 items-center justify-center rounded-sm border bg-[var(--surface-4)] transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MinusIcon className="size-3" />
          <span className="sr-only">Decrement</span>
        </Button>
        <Button
          slot="increment"
          className="border-input text-muted-foreground hover:bg-accent hover:text-foreground mr-1.5 flex aspect-square h-5 items-center justify-center rounded-sm border bg-[var(--surface-4)] transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon className="size-3" />
          <span className="sr-only">Increment</span>
        </Button>
      </Group>
    </NumberField>
  );
}
