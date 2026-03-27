"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";

/**
 * Checks whether the backend has been configured (credentials present).
 * If not, redirects to /setup. Skipped when already on /setup.
 */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/setup") return;

    api.getSetupStatus().then(({ configured }) => {
      if (!configured) {
        router.replace("/setup");
      }
    }).catch(() => {
      // Backend unreachable — let the page handle it normally.
    });
  }, [pathname, router]);

  return <>{children}</>;
}
