"use client";

import { X } from "lucide-react";
import * as React from "react";

import { DebouncedTextInput } from "@/components/filters/debounced-text-input";
import {
  MotionMultiselect,
  type MultiselectOption,
} from "@/components/ui/motion-multiselect";
import { RangeSliderField } from "@/components/ui/range-slider-field";
import { TriStateCheckbox } from "@/components/ui/tri-state-checkbox";
import { resolveFromHints } from "@/lib/filters/display-registry";
import {
  isAttributeActive,
  type FilterAttribute,
  type FilterSchemaResponse,
  type FilterState,
  type FilterValue,
} from "@/lib/filters/schema";
import { cn } from "@/lib/utils";

export interface FilterPanelProps {
  schema: FilterSchemaResponse;
  state: FilterState;
  onChange: (id: string, value: FilterValue) => void;
  open: boolean;
  className?: string;
  /** Max height of the inner scroll region when open. */
  maxHeightClass?: string;
}

/**
 * Collapsible panel rendering one card per filter attribute. The card chooses
 * the right primitive based on attribute.kind. Unknown attributes render as
 * a dimmed placeholder so the app does not break on backend drift.
 */
export function FilterPanel({
  schema,
  state,
  onChange,
  open,
  className,
  maxHeightClass = "max-h-[40vh]",
}: FilterPanelProps) {
  // Mount content once, keep mounted. First open pays the render cost; later
  // opens are pure CSS transition.
  const [hasOpened, setHasOpened] = React.useState(open);
  React.useEffect(() => {
    if (open && !hasOpened) setHasOpened(true);
  }, [open, hasOpened]);

  // Measure the content so we can animate `height` to an exact px value,
  // matching the track-editor resize pattern (single-property, known target).
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = React.useState(0);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      setContentHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasOpened]);

  const compacts = schema.attributes.filter((a) => a.kind !== "enum");
  const enums = schema.attributes.filter((a) => a.kind === "enum");

  return (
    <div
      style={{
        height: open ? contentHeight : 0,
        transitionProperty: "height",
        transitionDuration: "var(--dur-3)",
        transitionTimingFunction: "var(--ease-standard)",
      }}
      className={cn("overflow-hidden", className)}
      aria-hidden={!open}
    >
      <div ref={contentRef} className="border-border bg-background/60 border-b">
        <div className="px-3 py-2">
          <div className={cn("space-y-3 overflow-y-auto", maxHeightClass)}>
            {hasOpened && (
              <>
                {compacts.length > 0 && (
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] items-start gap-3">
                    {compacts.map((attr) => (
                      <CompactFilter
                        key={attr.id}
                        attr={attr}
                        value={state[attr.id]}
                        onChange={(v) => onChange(attr.id, v)}
                      />
                    ))}
                  </div>
                )}
                {enums.length > 0 && (
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {enums.map((attr) => (
                      <FilterCard
                        key={attr.id}
                        attr={attr}
                        value={state[attr.id]}
                        onChange={(v) => onChange(attr.id, v)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterCard({
  attr,
  value,
  onChange,
}: {
  attr: FilterAttribute;
  value: FilterValue | undefined;
  onChange: (v: FilterValue) => void;
}) {
  const display = resolveFromHints(attr);
  const Icon = display.icon;
  const active = value !== undefined && isAttributeActive(attr, value);

  return (
    <div className="border-border bg-surface-2 rounded-md border p-2">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium">
        {Icon && <Icon className="size-3.5 opacity-70" />}
        <span>{display.label}</span>
        {active && (
          <button
            type="button"
            onClick={() => onChange(emptyValueFor(attr))}
            className="text-muted-foreground hover:text-foreground ml-auto flex size-4 cursor-pointer items-center justify-center rounded-sm transition-colors"
            title={`Clear ${display.label}`}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <div>
        <AttributeInput attr={attr} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function emptyValueFor(attr: FilterAttribute): FilterValue {
  switch (attr.kind) {
    case "enum":
      return [];
    case "range":
      return [null, null];
    case "bool":
      return null;
    case "text":
      return "";
  }
}

/**
 * Uniform label-above-control stack for compact filter kinds (text, range, bool).
 * Each renders in a fixed-width column so the row has a consistent rhythm when
 * wrapped. No icons in this row — labels are short and icons add noise.
 */
function CompactFilter({
  attr,
  value,
  onChange,
}: {
  attr: FilterAttribute;
  value: FilterValue | undefined;
  onChange: (v: FilterValue) => void;
}) {
  const display = resolveFromHints(attr);

  if (attr.kind === "range" && (attr.max ?? 100) <= (attr.min ?? 0)) {
    return null;
  }
  if (attr.kind === "enum") return null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground px-0.5 text-xs font-medium">
        {display.label}
      </span>
      <div className="flex h-7 items-center">
        <CompactControl attr={attr} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function CompactControl({
  attr,
  value,
  onChange,
}: {
  attr: FilterAttribute;
  value: FilterValue | undefined;
  onChange: (v: FilterValue) => void;
}) {
  switch (attr.kind) {
    case "text":
      return (
        <DebouncedTextInput
          value={(value as string | undefined) ?? ""}
          onChange={onChange}
          placeholder="…"
        />
      );
    case "range":
    case "bool":
      return <AttributeInput attr={attr} value={value} onChange={onChange} />;
    case "enum":
      return null;
  }
}

function AttributeInput({
  attr,
  value,
  onChange,
}: {
  attr: FilterAttribute;
  value: FilterValue | undefined;
  onChange: (v: FilterValue) => void;
}) {
  const display = resolveFromHints(attr);

  switch (attr.kind) {
    case "enum": {
      const selected = (value as string[] | undefined) ?? [];
      const options: MultiselectOption[] = (attr.options ?? []).map((id) => ({
        id,
        label: id,
      }));
      return (
        <MotionMultiselect
          options={options}
          selected={selected}
          counts={attr.counts}
          compare={
            display.compareOptions
              ? (a, b) => display.compareOptions!(a.id, b.id)
              : undefined
          }
          onToggle={(id) =>
            onChange(
              selected.includes(id)
                ? selected.filter((s) => s !== id)
                : [...selected, id],
            )
          }
          emptyLabel="No options"
        />
      );
    }
    case "range": {
      const v = (value as [number | null, number | null] | undefined) ?? [
        null,
        null,
      ];
      const min = attr.min ?? 0;
      const max = attr.max ?? 100;
      if (max <= min) {
        return (
          <div className="text-muted-foreground px-1 py-1 text-xs">
            No range
          </div>
        );
      }
      return (
        <RangeSliderField
          min={min}
          max={max}
          step={attr.step ?? 1}
          value={v}
          onCommit={(next) => onChange(next)}
          format={display.format}
        />
      );
    }
    case "bool": {
      const v = (value as boolean | null | undefined) ?? null;
      return (
        <TriStateCheckbox
          value={v}
          onChange={(next) => onChange(next)}
          label={display.label}
        />
      );
    }
    case "text":
      return (
        <DebouncedTextInput
          value={(value as string | undefined) ?? ""}
          onChange={(v) => onChange(v)}
          placeholder={`Search ${display.label.toLowerCase()}…`}
        />
      );
  }
}
