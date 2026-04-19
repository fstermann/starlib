"use client";

import { ChevronDown, SlidersHorizontal } from "lucide-react";
import * as React from "react";

import { ActiveFilterChips } from "@/components/filters/active-filter-chips";
import { FilterPanel } from "@/components/filters/filter-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  emptyStateFor,
  isAttributeActive,
  type FilterSchemaResponse,
  type FilterState,
  type FilterValue,
} from "@/lib/filters/schema";
import { cn } from "@/lib/utils";

export interface FiltersToolbarProps {
  schema: FilterSchemaResponse;
  state: FilterState;
  onChange: (id: string, value: FilterValue) => void;
  onClearAll?: () => void;
  /** Rows after filtering. Always shown when provided. */
  filtered?: number;
  /** Rows before filtering. Rendered muted next to filtered when both differ. */
  total?: number;
  /** Noun for the count (singular). Defaults to "track". */
  unit?: string;
  /** Action buttons rendered right-aligned, before the count. */
  actions?: React.ReactNode;
  /** Trailing node (e.g. "loading…" indicator). Rendered after the count. */
  trailing?: React.ReactNode;
  /** Initial open state for the panel. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Thin always-visible strip + a collapsible filter panel below it.
 * Strip: [Filters toggle + count] [chips] [Clear all] [total →]
 */
export function FiltersToolbar({
  schema,
  state,
  onChange,
  onClearAll,
  filtered,
  total,
  unit = "track",
  actions,
  trailing,
  defaultOpen = false,
  className,
}: FiltersToolbarProps) {
  const [open, setOpen] = React.useState(defaultOpen);

  const activeCount = React.useMemo(() => {
    let n = 0;
    for (const attr of schema.attributes) {
      const v = state[attr.id];
      if (v !== undefined && isAttributeActive(attr, v)) n += 1;
    }
    return n;
  }, [schema, state]);

  function handleClearAll() {
    if (onClearAll) onClearAll();
    else {
      const empty = emptyStateFor(schema);
      for (const attr of schema.attributes) onChange(attr.id, empty[attr.id]);
    }
  }

  return (
    <div className={cn("border-border border-b", className)}>
      <div className="bg-background/80 flex flex-wrap items-center gap-2 px-3 py-2 backdrop-blur-sm">
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1 text-xs",
            activeCount > 0 && "border-primary text-primary",
          )}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <SlidersHorizontal className="size-3" />
          Filters
          {activeCount > 0 && (
            <Badge
              variant="default"
              className="ml-0.5 h-4 rounded-full px-1 text-xs"
            >
              {activeCount}
            </Badge>
          )}
          <ChevronDown
            className={cn(
              "size-3 opacity-50 transition-transform",
              open && "rotate-180",
            )}
          />
        </Button>

        <ActiveFilterChips schema={schema} state={state} onChange={onChange} />

        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-7 text-xs"
            onClick={handleClearAll}
          >
            Clear all
          </Button>
        )}

        <div className="text-muted-foreground ml-auto flex items-center gap-2 text-xs tabular-nums">
          {actions}
          {(filtered !== undefined || total !== undefined) && (
            <CountDisplay filtered={filtered} total={total} unit={unit} />
          )}
          {trailing}
        </div>
      </div>

      <FilterPanel
        schema={schema}
        state={state}
        onChange={onChange}
        open={open}
      />
    </div>
  );
}

function CountDisplay({
  filtered,
  total,
  unit,
}: {
  filtered: number | undefined;
  total: number | undefined;
  unit: string;
}) {
  // Latch the last displayed filtered value: table refetches briefly reset
  // items to [] (→ filtered=0) during loading, which would otherwise flicker
  // between the real count and 0. Only accept a new non-zero value, or zero
  // when it comes from "no matches" (i.e. filtered stays 0 across renders).
  const [stableFiltered, setStableFiltered] = React.useState(filtered);
  React.useEffect(() => {
    if (filtered === undefined) return;
    if (filtered === 0 && stableFiltered !== undefined && stableFiltered > 0) {
      // Probably a transient reload blip. Delay the drop briefly; if zero
      // sticks, the next effect run will commit it.
      const t = setTimeout(() => setStableFiltered(0), 300);
      return () => clearTimeout(t);
    }
    setStableFiltered(filtered);
  }, [filtered, stableFiltered]);

  const primary = stableFiltered ?? total;
  if (primary === undefined) return null;
  const showBoth =
    stableFiltered !== undefined &&
    total !== undefined &&
    stableFiltered !== total;
  const noun = `${unit}${primary === 1 ? "" : "s"}`;
  return (
    <span>
      <span className="text-foreground font-medium">
        {primary.toLocaleString()}
      </span>
      {showBoth && <> / {total!.toLocaleString()}</>} {noun}
    </span>
  );
}
