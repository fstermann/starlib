"use client";

import { Headphones } from "lucide-react";

import { useCommand } from "@/components/command-palette";
import { setHeadphoneSync, useHeadphoneSync } from "@/lib/headphone-sync";
import { cn } from "@/lib/utils";

/** Top-bar toggle: delay playheads and live visuals by the output device's latency. */
export function HeadphoneSyncToggle() {
  const { enabled, deviceLatency } = useHeadphoneSync();
  const delay =
    enabled && deviceLatency != null
      ? ` (${Math.round(deviceLatency * 1000)} ms)`
      : "";
  const title = enabled
    ? `Headphone sync on${delay}: playheads wait for your output's delay`
    : "Headphone sync: make playheads match what you hear over Bluetooth";

  useCommand({
    id: "headphone-sync:toggle",
    label: enabled ? "Turn off headphone sync" : "Turn on headphone sync",
    description:
      "Delay playheads and the spectrum by your output device's latency, for Bluetooth headphones.",
    icon: Headphones,
    keywords: [
      "headphones",
      "bluetooth",
      "airpods",
      "latency",
      "delay",
      "sync",
    ],
    group: "Audio",
    run: ({ close }) => {
      setHeadphoneSync(!enabled);
      close();
    },
  });

  return (
    <button
      type="button"
      onClick={() => setHeadphoneSync(!enabled)}
      aria-pressed={enabled}
      aria-label="Headphone sync"
      title={title}
      data-testid="headphone-sync"
      className={cn(
        "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
        enabled
          ? "bg-[var(--brand-soft)] text-[var(--brand)]"
          : "text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]",
      )}
    >
      <Headphones className="size-3.5" aria-hidden />
    </button>
  );
}
