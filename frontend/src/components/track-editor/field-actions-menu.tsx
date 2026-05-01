"use client";

import { MoreHorizontal } from "lucide-react";
import type { ComponentType } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface FieldAction {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
  disabled?: boolean;
}

interface FieldActionsMenuProps {
  field: string;
  actions: FieldAction[];
}

/**
 * Per-field "⋯" dropdown collapsing low-frequency text transforms (Clean,
 * Titelize, Remove brackets, Isolate, Build-from-remix, …) behind one
 * trigger. Renders nothing when ``actions`` is empty so unrelated fields
 * stay quiet.
 */
export function FieldActionsMenu({ field, actions }: FieldActionsMenuProps) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`More actions for ${field}`}
          title="More actions"
          data-command-id={`field-actions-${field}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={a.onSelect}
              disabled={a.disabled}
              data-action-id={a.id}
              className="text-xs"
            >
              <Icon className="size-3.5" />
              {a.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
