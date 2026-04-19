"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface DebouncedTextInputProps {
  value: string;
  onChange: (value: string) => void;
  delayMs?: number;
  placeholder?: string;
  className?: string;
}

/**
 * Text input that commits to the parent after a delay. Keeps typing snappy
 * without triggering per-keystroke URL writes / schema refetches / table
 * re-fetches.
 */
export function DebouncedTextInput({
  value,
  onChange,
  delayMs = 300,
  placeholder,
  className,
}: DebouncedTextInputProps) {
  const [local, setLocal] = React.useState(value);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = React.useRef(value);

  // If the external value changes (e.g. cleared from a chip), sync in.
  React.useEffect(() => {
    if (value !== lastCommitted.current) {
      setLocal(value);
      lastCommitted.current = value;
    }
  }, [value]);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function handleChange(next: string) {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastCommitted.current = next;
      onChange(next);
    }, delayMs);
  }

  return (
    <input
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "border-input bg-background focus-visible:ring-ring/30 h-7 w-full rounded-sm border px-2 text-xs outline-none focus-visible:ring-2",
        className,
      )}
    />
  );
}
