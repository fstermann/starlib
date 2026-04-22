"use client";

import { useMemo } from "react";

import type { CommandProvider } from "@/components/command-palette/types";
import { NAV_LINKS, QUICK_JUMPS } from "@/lib/nav-config";

import { useRegisterProvider } from "../use-register-provider";

/** Static provider: "Go to X" entries for every nav route and quick-jump. */
export function NavProvider({
  onNavigate,
}: {
  onNavigate: (href: string) => void;
}) {
  const provider = useMemo<CommandProvider>(
    () => ({
      id: "nav",
      order: 10,
      mode: "sync",
      provide: () => {
        const seen = new Set<string>();
        const combined = [...NAV_LINKS, ...QUICK_JUMPS].filter((link) => {
          if (seen.has(link.href)) return false;
          seen.add(link.href);
          return true;
        });
        return combined.map((link) => ({
          id: `nav:${link.href}`,
          label: `Go to ${link.label}`,
          icon: link.icon,
          group: "Go to",
          keywords: [
            "nav",
            "goto",
            link.label.toLowerCase(),
            ...(link.keywords ?? []),
          ],
          run: ({ close }) => {
            onNavigate(link.href);
            close();
          },
        }));
      },
    }),
    [onNavigate],
  );

  useRegisterProvider(provider);
  return null;
}
