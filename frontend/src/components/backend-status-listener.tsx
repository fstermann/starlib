"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import { isTauri } from "@/lib/tauri";

/**
 * Surfaces the sidecar lifecycle events emitted by the Rust layer.
 *
 * `backend-disconnected` fires on every sidecar exit (the watchdog then
 * retries), `backend-error` when it gave up or never became healthy.
 */
export function BackendStatusListener() {
  useEffect(() => {
    if (!isTauri()) return;

    const unlisteners: (() => void)[] = [];
    let cancelled = false;

    import("@tauri-apps/api/event").then(async (mod) => {
      const disconnected = await mod.listen<string>(
        "backend-disconnected",
        () => {
          toast.warning("Backend stopped — restarting…", {
            id: "backend-status",
          });
        },
      );
      const failed = await mod.listen<string>("backend-error", (event) => {
        toast.error(event.payload || "Backend unavailable", {
          id: "backend-status",
          duration: Infinity,
        });
      });
      if (cancelled) {
        disconnected();
        failed();
        return;
      }
      unlisteners.push(disconnected, failed);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  return null;
}
