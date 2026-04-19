"use client";

import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as React from "react";

/**
 * Wraps a horizontal list of header cells so users can drag-reorder them.
 * Items are identified by string id; parent receives onOrderChange with the
 * full new order. Children are rendered via <SortableHeaderCell id={...}>.
 */
export function SortableColumnHeader({
  ids,
  onOrderChange,
  children,
}: {
  ids: string[];
  onOrderChange: (nextIds: string[]) => void;
  children: React.ReactNode;
}) {
  // Require ~6px movement before drag starts so column-header click-to-sort
  // still works without accidental drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const next = [...ids];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    onOrderChange(next);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * Draggable header cell. `children` renders the cell contents; the drag
 * handle is the whole cell. Consumers can still attach click handlers —
 * pointer sensor's activation distance keeps clicks separate from drags.
 */
export function SortableHeaderCell({
  id,
  className,
  style: styleProp,
  onResize,
  onResetWidth,
  children,
}: {
  id: string;
  className?: string;
  style?: React.CSSProperties;
  /** When provided, renders a resize handle on the right edge. Fires with
   *  the new pixel width as the user drags; commit (persist) at pointer-up. */
  onResize?: (width: number, phase: "drag" | "commit") => void;
  /** Double-click on the resize handle resets this column's width. */
  onResetWidth?: () => void;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const cellRef = React.useRef<HTMLDivElement | null>(null);
  const style: React.CSSProperties = {
    ...styleProp,
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    cursor: isDragging ? "grabbing" : "grab",
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
  };
  return (
    <div
      ref={(el) => {
        cellRef.current = el;
        setNodeRef(el);
      }}
      style={style}
      className={className}
      {...attributes}
      {...listeners}
    >
      {children}
      {onResize && (
        <ResizeHandle
          cellRef={cellRef}
          onResize={onResize}
          onResetWidth={onResetWidth}
        />
      )}
    </div>
  );
}

function ResizeHandle({
  cellRef,
  onResize,
  onResetWidth,
}: {
  cellRef: React.RefObject<HTMLDivElement | null>;
  onResize: (width: number, phase: "drag" | "commit") => void;
  onResetWidth?: () => void;
}) {
  // stopPropagation so dnd-kit's drag sensor doesn't start on pointer-down.
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.preventDefault();
    const cell = cellRef.current;
    if (!cell) return;
    const startX = e.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    function onMove(ev: PointerEvent) {
      const w = Math.max(40, startWidth + (ev.clientX - startX));
      onResize(w, "drag");
    }
    function onUp(ev: PointerEvent) {
      const w = Math.max(40, startWidth + (ev.clientX - startX));
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      onResize(w, "commit");
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }
  function handleDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.preventDefault();
    onResetWidth?.();
  }
  return (
    <div
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      className="hover:bg-primary/40 active:bg-primary/60 absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize"
      style={{ cursor: "col-resize" }}
      title="Drag to resize · double-click to reset"
      aria-hidden
    />
  );
}
