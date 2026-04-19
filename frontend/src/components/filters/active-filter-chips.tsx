"use client";

import { X } from "lucide-react";

import { resolveFromHints } from "@/lib/filters/display-registry";
import {
  isAttributeActive,
  type FilterAttribute,
  type FilterSchemaResponse,
  type FilterState,
  type FilterValue,
} from "@/lib/filters/schema";

export interface ActiveFilterChipsProps {
  schema: FilterSchemaResponse;
  state: FilterState;
  onChange: (id: string, value: FilterValue) => void;
}

/**
 * Renders one grouped chip per active filter: [Icon Label │ value × │ value ×].
 * Grouping makes it clear which source filter a value belongs to, and each
 * value is independently removable.
 */
export function ActiveFilterChips({
  schema,
  state,
  onChange,
}: ActiveFilterChipsProps) {
  const groups = schema.attributes
    .map((attr) => {
      const value = state[attr.id];
      if (value === undefined || !isAttributeActive(attr, value)) return null;
      return { attr, value };
    })
    .filter((g): g is { attr: FilterAttribute; value: FilterValue } => !!g);

  return (
    <>
      {groups.map(({ attr, value }) => (
        <FilterChipGroup
          key={attr.id}
          attr={attr}
          value={value}
          onChange={onChange}
        />
      ))}
    </>
  );
}

function FilterChipGroup({
  attr,
  value,
  onChange,
}: {
  attr: FilterAttribute;
  value: FilterValue;
  onChange: (id: string, value: FilterValue) => void;
}) {
  const display = resolveFromHints(attr);
  const Icon = display.icon;

  const segments = chipSegments(attr, value, onChange, display.format);

  return (
    <div className="border-border bg-surface-2 flex h-6 items-center overflow-hidden rounded-full border text-xs">
      <span className="text-muted-foreground flex items-center gap-1 px-2 font-medium">
        {Icon && <Icon className="size-3 opacity-70" />}
        {display.label}
      </span>
      <span className="border-border h-full border-l" />
      <div className="flex h-full items-center">
        {segments.map((seg, i) => (
          <span key={seg.key} className="flex h-full items-center">
            {i > 0 && <span className="text-muted-foreground/50">·</span>}
            <button
              type="button"
              onClick={seg.onRemove}
              className="hover:bg-accent group flex h-full items-center gap-1 px-2 transition-colors"
              title="Remove"
            >
              <span>{seg.label}</span>
              <X className="text-muted-foreground group-hover:text-foreground size-2.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

interface ChipSegment {
  key: string;
  label: string;
  onRemove: () => void;
}

function chipSegments(
  attr: FilterAttribute,
  value: FilterValue,
  onChange: (id: string, value: FilterValue) => void,
  format?: (n: number) => string,
): ChipSegment[] {
  switch (attr.kind) {
    case "enum": {
      const selected = value as string[];
      return selected.map((id) => ({
        key: id,
        label: id,
        onRemove: () =>
          onChange(
            attr.id,
            selected.filter((s) => s !== id),
          ),
      }));
    }
    case "range": {
      const [lo, hi] = value as [number | null, number | null];
      const fmt = format ?? ((n: number) => String(n));
      const text = `${lo == null ? "…" : fmt(lo)}–${hi == null ? "…" : fmt(hi)}`;
      return [
        {
          key: "range",
          label: text,
          onRemove: () => onChange(attr.id, [null, null]),
        },
      ];
    }
    case "bool": {
      const v = value as boolean;
      return [
        {
          key: "bool",
          label: v ? "yes" : "no",
          onRemove: () => onChange(attr.id, null),
        },
      ];
    }
    case "text": {
      const v = value as string;
      return [
        {
          key: "text",
          label: `"${v}"`,
          onRemove: () => onChange(attr.id, ""),
        },
      ];
    }
  }
}
