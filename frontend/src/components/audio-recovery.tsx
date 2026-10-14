"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { useCommand } from "@/components/command-palette/use-command";
import { restartSharedAudioOutput } from "@/lib/looping-web-audio-player";
import {
  CANVASES_LOST_EVENT,
  isTauri,
  restartWebkitGpuProcess,
} from "@/lib/tauri";

/** A gap this long between timer ticks means the Mac slept. */
const WAKE_GAP_MS = 30_000;
const TICK_MS = 5_000;
const GPU_RECONNECT_MS = 500;

/**
 * In the desktop app, replace WebKit's GPU process: after sleep it can stop
 * playing every audio context, and only a fresh process brings sound back.
 * In a browser, restart the shared context's output.
 */
async function restartAudio(reason: string): Promise<void> {
  if (!isTauri()) {
    await restartSharedAudioOutput();
    return;
  }
  if (!(await restartWebkitGpuProcess())) return;
  // The page connects to the new GPU process shortly after it launches.
  await new Promise((resolve) => setTimeout(resolve, GPU_RECONNECT_MS));
  window.dispatchEvent(new Event(CANVASES_LOST_EVENT));
  const { info } = await import("@tauri-apps/plugin-log");
  await info(`[audio] restarted WebKit GPU process after ${reason}`);
}

/** Restarts audio output after sleep, and offers it in the palette. */
export function AudioRecovery() {
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (now - last > WAKE_GAP_MS) void restartAudio("wake");
      last = now;
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  useCommand({
    id: "audio:restart",
    label: "Restart audio",
    description:
      "Restart audio output when playback runs but nothing is heard.",
    icon: RotateCcw,
    keywords: ["audio", "sound", "silent", "restart", "output", "fix"],
    group: "Audio",
    run: async ({ close }) => {
      close();
      try {
        await restartAudio("palette");
        toast.success("Audio restarted");
      } catch (err) {
        toast.error(`Couldn't restart audio: ${String(err)}`);
      }
    },
  });

  return null;
}
