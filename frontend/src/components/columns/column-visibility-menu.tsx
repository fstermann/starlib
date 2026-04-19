"use client";

import { ArrowLeftRight, Columns3, Eye, MoveHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ColumnDef } from "@/lib/columns/types";

export interface ColumnVisibilityMenuProps {
  columns: ColumnDef[];
  isVisible: (id: string) => boolean;
  setHidden: (id: string, hidden: boolean) => void;
  /** Restore all columns to visible. */
  onResetVisibility: () => void;
  /** Optional: reset the column order. Only shown when drag-reorder is wired. */
  onResetOrder?: () => void;
  /** Optional: reset the column widths. Only shown when resize is wired. */
  onResetWidths?: () => void;
  className?: string;
}

/**
 * Dropdown menu for toggling column visibility per view. Required columns
 * render as dimmed, non-interactive checkboxes so the user sees them but
 * can't hide them.
 */
export function ColumnVisibilityMenu({
  columns,
  isVisible,
  setHidden,
  onResetVisibility,
  onResetOrder,
  onResetWidths,
  className,
}: ColumnVisibilityMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={className} title="Columns">
          <Columns3 className="size-3.5" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          Columns
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={isVisible(col.id)}
            disabled={col.required}
            onCheckedChange={(v) => setHidden(col.id, !v)}
            onSelect={(e) => e.preventDefault()}
            className="text-xs"
          >
            {col.header}
            {col.required && (
              <span className="text-muted-foreground ml-1.5 text-[10px]">
                required
              </span>
            )}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        {onResetOrder && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onResetOrder();
            }}
            className="text-muted-foreground text-xs"
          >
            <ArrowLeftRight className="size-3" />
            Reset order
          </DropdownMenuItem>
        )}
        {onResetWidths && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onResetWidths();
            }}
            className="text-muted-foreground text-xs"
          >
            <MoveHorizontal className="size-3" />
            Reset widths
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onResetVisibility();
          }}
          className="text-muted-foreground text-xs"
        >
          <Eye className="size-3" />
          Reset visibility
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
