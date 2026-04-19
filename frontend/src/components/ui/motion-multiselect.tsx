"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import * as React from "react";

import { cn } from "@/lib/utils";

const ROW_HEIGHT = 24; // must match the button's computed height (text-xs + py-1)

export interface MultiselectOption {
  id: string;
  label: string;
}

export interface MotionMultiselectItemRenderProps {
  option: MultiselectOption;
  selected: boolean;
  disabled: boolean;
  count: number | undefined;
  onToggle: () => void;
}

export interface MotionMultiselectProps {
  options: MultiselectOption[];
  selected: string[];
  onToggle: (id: string) => void;
  counts?: Record<string, number>;
  /** Comparator applied AFTER the selected-first sort. Default: count desc, then label. */
  compare?: (a: MultiselectOption, b: MultiselectOption) => number;
  /** Override row rendering (e.g. DropdownMenuCheckboxItem). Default: plain button. */
  renderItem?: (props: MotionMultiselectItemRenderProps) => React.ReactNode;
  emptyLabel?: string;
  className?: string;
  maxHeightClass?: string;
  /**
   * When option count exceeds this, disable the per-row layout animation.
   * Rows still float-to-top on select, they just snap instead of animating.
   * Keeps large lists (e.g. 100+ genres) snappy.
   */
  maxAnimatedItems?: number;
}

function defaultCompare(): (
  a: MultiselectOption,
  b: MultiselectOption,
) => number {
  return (a, b) => a.label.localeCompare(b.label);
}

function DefaultItem({
  option,
  selected,
  disabled,
  count,
  onToggle,
}: MotionMultiselectItemRenderProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "hover:bg-accent hover:text-accent-foreground flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "border-input flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
            selected && "bg-primary border-primary text-primary-foreground",
          )}
        >
          {selected && (
            <svg
              viewBox="0 0 12 12"
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M2 6l3 3 5-6" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="truncate">{option.label}</span>
      </span>
      {count !== undefined && (
        <span className="text-muted-foreground tabular-nums">{count}</span>
      )}
    </button>
  );
}

/**
 * Multiselect list where selected rows float to the top with a layout
 * animation, and scroll position is preserved when toggling an item near the
 * bottom. Extracted from collection-filter-bar.tsx (genre/key dropdowns).
 */
export function MotionMultiselect({
  options,
  selected,
  onToggle,
  counts,
  compare,
  renderItem = DefaultItem,
  emptyLabel,
  className,
  maxHeightClass = "max-h-56",
  maxAnimatedItems = 40,
}: MotionMultiselectProps) {
  const animate = options.length <= maxAnimatedItems;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const savedScroll = React.useRef(0);
  const restoreScroll = React.useRef(false);

  React.useLayoutEffect(() => {
    if (restoreScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = savedScroll.current;
      restoreScroll.current = false;
    }
  });

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  // Rank snapshot: sorted selected-first + secondary sort, re-ranked ONLY
  // when the option set or selection changes. Count updates alone do not
  // re-rank — avoids wave-of-animations reshuffle on large lists.
  //
  // Secondary sort rule:
  //   - If a custom `compare` is provided (e.g. Camelot for keys), honor it
  //     exclusively. Intrinsic order wins over counts.
  //   - Otherwise, sort unselected by counts desc, then alphabetical.
  const sorted = React.useMemo(() => {
    const hasCustomOrder = !!compare;
    const secondary = compare ?? defaultCompare();
    return [...options].sort((a, b) => {
      const aSel = selectedSet.has(a.id);
      const bSel = selectedSet.has(b.id);
      if (aSel !== bSel) return aSel ? -1 : 1;
      if (hasCustomOrder || (aSel && bSel)) return secondary(a, b);
      const ac = counts?.[a.id] ?? 0;
      const bc = counts?.[b.id] ?? 0;
      return bc - ac || secondary(a, b);
    });
    // Intentionally omitting `counts` from deps: count changes should not
    // reshuffle. Re-rank only on option/selection boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, selectedSet, compare]);

  const handleToggle = React.useCallback(
    (id: string) => {
      savedScroll.current = scrollRef.current?.scrollTop ?? 0;
      restoreScroll.current = true;
      onToggle(id);
    },
    [onToggle],
  );

  if (options.length === 0 && emptyLabel) {
    return (
      <div className="text-muted-foreground px-2 py-1 text-xs">
        {emptyLabel}
      </div>
    );
  }

  if (!animate) {
    return (
      <VirtualList
        scrollRef={scrollRef}
        options={sorted}
        selectedSet={selectedSet}
        counts={counts}
        onToggle={handleToggle}
        renderItem={renderItem}
        className={cn("overflow-y-auto", maxHeightClass, className)}
      />
    );
  }

  return (
    <motion.div
      ref={scrollRef}
      layoutScroll
      className={cn("overflow-y-auto", maxHeightClass, className)}
    >
      <AnimatePresence initial={false}>
        {sorted.map((opt) => {
          const count = counts?.[opt.id];
          const isSelected = selectedSet.has(opt.id);
          const isDisabled = !isSelected && count === 0;
          return (
            <MemoRow
              key={opt.id}
              option={opt}
              selected={isSelected}
              disabled={isDisabled}
              count={count}
              onToggle={handleToggle}
              renderItem={renderItem}
              animate
            />
          );
        })}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * Windowed renderer for large option lists (e.g. 109 genres). Only the
 * ~15 visible rows are mounted to the DOM at any time; scrolling swaps them
 * in/out. Scales to thousands of options.
 */
function VirtualList({
  scrollRef,
  options,
  selectedSet,
  counts,
  onToggle,
  renderItem,
  className,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  options: MultiselectOption[];
  selectedSet: Set<string>;
  counts: Record<string, number> | undefined;
  onToggle: (id: string) => void;
  renderItem: (props: MotionMultiselectItemRenderProps) => React.ReactNode;
  className?: string;
}) {
  // React Compiler can't memoize TanStack Virtual's returned functions; suppressing the
  // warning matches the pattern used in likes-table / collection-table.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: options.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  });

  const total = virtualizer.getTotalSize();
  return (
    <div ref={scrollRef} className={className}>
      <div style={{ height: total, position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const opt = options[vi.index];
          const count = counts?.[opt.id];
          const isSelected = selectedSet.has(opt.id);
          const isDisabled = !isSelected && count === 0;
          return (
            <div
              key={opt.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderItem({
                option: opt,
                selected: isSelected,
                disabled: isDisabled,
                count,
                onToggle: () => onToggle(opt.id),
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  option: MultiselectOption;
  selected: boolean;
  disabled: boolean;
  count: number | undefined;
  onToggle: (id: string) => void;
  renderItem: (props: MotionMultiselectItemRenderProps) => React.ReactNode;
  animate: boolean;
}

/**
 * Memoized row. Prevents a re-render cascade when the parent receives a new
 * counts object but THIS row's count/selected/disabled haven't changed.
 * When `animate` is false (large list), renders a plain div — no layout
 * measurement, no transition.
 */
const MemoRow = React.memo(function MemoRow({
  option,
  selected,
  disabled,
  count,
  onToggle,
  renderItem,
  animate,
}: RowProps) {
  const body = renderItem({
    option,
    selected,
    disabled,
    count,
    onToggle: () => onToggle(option.id),
  });
  if (!animate) return <div>{body}</div>;
  return (
    <motion.div layout transition={{ duration: 0.2, ease: "easeOut" }}>
      {body}
    </motion.div>
  );
});
