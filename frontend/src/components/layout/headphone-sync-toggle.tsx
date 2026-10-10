"use client";

import { Headphones } from "lucide-react";

import { useCommand } from "@/components/command-palette";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { setHeadphoneSync, useHeadphoneSync } from "@/lib/headphone-sync";
import { cn } from "@/lib/utils";

/** Top-bar toggle: delay playheads and live visuals by the output device's latency. */
export function HeadphoneSyncToggle() {
  const { enabled, deviceLatency } = useHeadphoneSync();
  const delayMs =
    deviceLatency != null ? Math.round(deviceLatency * 1000) : null;

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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setHeadphoneSync(!enabled)}
          aria-pressed={enabled}
          aria-label="Headphone sync"
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
      </TooltipTrigger>
      <TooltipContent className="max-w-64" data-testid="headphone-sync-tooltip">
        <p className="font-medium">
          Headphone sync {enabled ? "on" : "off"}
          {enabled && delayMs != null && ` · ${delayMs} ms`}
        </p>
        <p className="opacity-80">
          Bluetooth headphones play audio a moment after it&apos;s sent, so
          playheads run ahead of what you hear. Turn this on to hold playheads
          back by your output device&apos;s delay.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
