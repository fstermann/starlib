"use client";

import { useEffect, useRef } from "react";

import { useCommandPalette } from "./provider";
import type { CommandItem } from "./types";

export interface UseCommandOptions extends Omit<CommandItem, "id"> {
  id: string;
  /** If false, the command is not registered. Use for conditional availability. */
  when?: boolean;
}

/**
 * Register a command that exists while the calling component is mounted.
 *
 * Re-registration only happens when `id` or `when` changes. All other props
 * (label, icon, run, keywords) are read from a ref, so normal React re-renders
 * and label/icon updates do not thrash the global registry.
 */
export function useCommand(opts: UseCommandOptions) {
  const { registerCommand } = useCommandPalette();
  const ref = useRef(opts);
  ref.current = opts;

  const { id, when = true } = opts;

  useEffect(() => {
    if (!when) return;
    return registerCommand({
      id,
      get label() {
        return ref.current.label;
      },
      get description() {
        return ref.current.description;
      },
      get icon() {
        return ref.current.icon;
      },
      get imageUrl() {
        return ref.current.imageUrl;
      },
      get group() {
        return ref.current.group;
      },
      get keywords() {
        return ref.current.keywords;
      },
      get shortcut() {
        return ref.current.shortcut;
      },
      run: (ctx) => ref.current.run(ctx),
    });
  }, [id, when, registerCommand]);
}
