"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CommandItem, CommandProvider } from "./types";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Register a dynamic, lifecycle-bound command. Returns an unregister fn. */
  registerCommand: (item: CommandItem) => () => void;
  /** Register a static/async provider (typically once at app boot). */
  registerProvider: (provider: CommandProvider) => () => void;
  /** Snapshot for the palette dialog. */
  dynamicCommands: CommandItem[];
  providers: CommandProvider[];
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
  null,
);

export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dynamicCommands, setDynamicCommands] = useState<CommandItem[]>([]);
  const [providers, setProviders] = useState<CommandProvider[]>([]);

  // Warn about duplicate ids in dev.
  const seenIdsRef = useRef<Map<string, number>>(new Map());

  const registerCommand = useCallback((item: CommandItem) => {
    if (process.env.NODE_ENV !== "production") {
      const count = (seenIdsRef.current.get(item.id) ?? 0) + 1;
      seenIdsRef.current.set(item.id, count);
      if (count > 1) {
        console.warn(
          `[command-palette] duplicate command id "${item.id}" registered`,
        );
      }
    }
    setDynamicCommands((prev) => [...prev, item]);
    return () => {
      setDynamicCommands((prev) => prev.filter((c) => c !== item));
      if (process.env.NODE_ENV !== "production") {
        const count = (seenIdsRef.current.get(item.id) ?? 1) - 1;
        if (count <= 0) seenIdsRef.current.delete(item.id);
        else seenIdsRef.current.set(item.id, count);
      }
    };
  }, []);

  const registerProvider = useCallback((provider: CommandProvider) => {
    setProviders((prev) => [...prev, provider]);
    return () => {
      setProviders((prev) => prev.filter((p) => p !== provider));
    };
  }, []);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Global ⌘P / Ctrl+P hotkey.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "p" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      registerCommand,
      registerProvider,
      dynamicCommands,
      providers,
    }),
    [
      open,
      toggle,
      registerCommand,
      registerProvider,
      dynamicCommands,
      providers,
    ],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used inside <CommandPaletteProvider>",
    );
  }
  return ctx;
}
