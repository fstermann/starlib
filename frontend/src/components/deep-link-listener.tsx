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

    let unlistenEvent: (() => void) | undefined;

    import("@tauri-apps/plugin-deep-link").then(async (mod) => {
      unlisten = await mod.onOpenUrl((urls) => {
        for (const u of urls) handleUrl(u);
      });

      const initial = await mod.getCurrent();
      if (initial && initial.length > 0) {
        for (const u of initial) handleUrl(u);
      }
    });

    // Also listen for the `deep-link` Tauri event. The Rust side emits this
    // both from the deep_link plugin's native handler AND from the
    // single_instance callback when macOS launches the registered packaged
    // app while this process holds the single-instance lock (argv forwarding).
    // Without this the dev session misses OAuth callbacks.
    import("@tauri-apps/api/event").then(async (mod) => {
      unlistenEvent = await mod.listen<string>("deep-link", (event) => {
        handleUrl(event.payload);
      });
    });

    return () => {
      unlisten?.();
      unlistenEvent?.();
    };
  }, [router]);

  return null;
}
