"use client";

import { useEffect, useState } from "react";

import { LogoSpinner } from "@/components/logo-spinner";
import { api } from "@/lib/api";

const POLL_INTERVAL_MS = 500;

export function BackendGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      while (!cancelled) {
        try {
          await api.healthCheck();
          if (!cancelled) setReady(true);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  if (ready) return <>{children}</>;

  return (
    <div className="bg-background fixed inset-0 z-100 flex items-center justify-center">
      <LogoSpinner />
    </div>
  );
}
