"use client";

import { useEffect } from "react";

import { isTauri } from "@/lib/tauri";

export function LogInit() {
  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/plugin-log").then(({ attachConsole }) =>
      attachConsole(),
    );
  }, []);

  return null;
}
