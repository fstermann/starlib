import type { ComponentType, SVGProps } from "react";

export type CommandIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: string | number }
>;

export interface CommandRunContext {
  close: () => void;
  query: string;
}

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon?: CommandIcon;
  /** Optional image URL, used in place of `icon` when present. */
  imageUrl?: string;
  group: string;
  keywords?: string[];
  shortcut?: string[];
  run: (ctx: CommandRunContext) => void | Promise<void>;
  /** When set, the item gains a right-click "Play next" / "Add to queue" menu.
   * Both callbacks must be provided together. */
  onPlayNext?: () => void;
  onAddToQueue?: () => void;
}

export type CommandProvideResult = CommandItem[];

export interface CommandProvider {
  id: string;
  /** Lower number = earlier group in list. */
  order?: number;
  /** "sync" providers are filtered client-side by cmdk. "async" providers run on query change. */
  mode: "sync" | "async";
  /** Minimum query length before async provider runs (default 2). Ignored for sync. */
  minQueryLength?: number;
  provide: (
    query: string,
    signal: AbortSignal,
  ) => CommandProvideResult | Promise<CommandProvideResult>;
}
