"use client";

import { ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  FieldSuggestion,
  SuggestionField,
} from "@/lib/sources/suggestions";

interface SuggestionButtonProps {
  field: SuggestionField;
  suggestions: FieldSuggestion[] | undefined;
  /** Current editor value, used only to render the diff pill. */
  currentValue: string;
  onAccept: (suggestion: FieldSuggestion) => void;
  className?: string;
}

/**
 * Per-field accept-suggestion control.
 *
 * Two visual modes:
 *
 * - **Single candidate** — a plain icon button. Tooltip shows the source label
 *   and the value (or a `current → new` diff when the field has a value).
 * - **Multiple candidates** — a split: primary icon accepts the top, the
 *   chevron opens a popover listing all alternatives with their source label
 *   and confidence bar.
 *
 * Renders nothing when ``suggestions`` is empty/undefined — the engine is
 * already responsible for hiding suggestions equal to the current value, so
 * if the array is non-empty there is always something useful to do.
 */
export function SuggestionButton({
  field,
  suggestions,
  currentValue,
  onAccept,
  className,
}: SuggestionButtonProps) {
  const [open, setOpen] = useState(false);

  if (!suggestions || suggestions.length === 0) return null;
  const top = suggestions[0];
  const hasMultiple = suggestions.length > 1;
  const formatValue = (v: unknown) =>
    v === null || v === undefined ? "—" : String(v);

  const tooltip = currentValue
    ? `${formatValue(currentValue)} → ${formatValue(top.value)}`
    : `Suggestion: ${formatValue(top.value)} (${top.label})`;

  return (
    <div
      className={`flex items-center ${className ?? ""}`}
      data-suggestion-field={field}
    >
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-brand"
              onClick={() => onAccept(top)}
              data-command-id={`suggestion-accept-${field}`}
              aria-label={`Accept suggestion for ${field}`}
            >
              <Sparkles />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {hasMultiple && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Show alternative suggestions for ${field}`}
              data-command-id={`suggestion-open-${field}`}
            >
              <ChevronDown />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1" align="end">
            <div className="space-y-0.5">
              {suggestions.map((s, i) => (
                <button
                  key={`${s.source}-${i}`}
                  type="button"
                  onClick={() => {
                    onAccept(s);
                    setOpen(false);
                  }}
                  className="hover:bg-accent w-full rounded px-2 py-1.5 text-left text-xs transition-colors"
                  data-suggestion-source={s.source}
                >
                  <div className="text-foreground truncate">
                    {formatValue(s.value)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="text-muted-foreground text-2xs">
                      {s.label}
                    </span>
                    <span
                      className="bg-brand/30 ml-auto h-1 rounded-full"
                      style={{ width: `${Math.round(s.confidence * 60)}px` }}
                      aria-label={`confidence ${Math.round(s.confidence * 100)}%`}
                    />
                  </div>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
