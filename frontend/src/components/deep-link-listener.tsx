"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { isTauri } from "@/lib/tauri";

export function DeepLinkListener() {
  const router = useRouter();

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    const seen = new Set<string>();

    const handleUrl = (raw: string) => {
      if (seen.has(raw)) return;
      seen.add(raw);
      console.log("[deep-link] handling", raw);
      try {
        const url = new URL(raw);
        const path = url.pathname || "/";
        router.push(`${path}${url.search}`);
      } catch (err) {
        console.error("[deep-link] parse failed", err);
      }
    };

    import("@tauri-apps/plugin-deep-link").then(async (mod) => {
      unlisten = await mod.onOpenUrl((urls) => {
        for (const u of urls) handleUrl(u);
      });

      const initial = await mod.getCurrent();
      if (initial && initial.length > 0) {
        for (const u of initial) handleUrl(u);
      }
    });

    return () => {
      unlisten?.();
    };
  }, [router]);

  return null;
}
