"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface TriStateCheckboxProps {
  /** null = unset, true = include, false = exclude */
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  label?: React.ReactNode;
  className?: string;
}

/** Three-way: unset → true → false → unset. */
export function TriStateCheckbox({
  value,
  onChange,
  label,
  className,
}: TriStateCheckboxProps) {
  function cycle() {
    if (value === null) onChange(true);
    else if (value === true) onChange(false);
    else onChange(null);
  }

  const isTrue = value === true;
  const isFalse = value === false;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={value === null ? "mixed" : value}
      onClick={cycle}
      className={cn(
        "hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "border-input flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
          isTrue && "bg-primary border-primary text-primary-foreground",
          isFalse && "bg-destructive border-destructive text-white",
        )}
      >
        {isTrue && <CheckIcon className="size-2.5" />}
        {isFalse && <MinusIcon className="size-2.5" />}
      </span>
      {label && <span className="truncate">{label}</span>}
    </button>
  );
}
