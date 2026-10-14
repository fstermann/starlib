"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { useCommand } from "@/components/command-palette/use-command";
import { restartSharedAudioOutput } from "@/lib/looping-web-audio-player";
import { isTauri } from "@/lib/tauri";

/** A gap this long between timer ticks means the Mac slept. */
const WAKE_GAP_MS = 30_000;
const TICK_MS = 5_000;

async function restartAudio(reason: string): Promise<void> {
  const restarted = await restartSharedAudioOutput();
  if (!restarted || !isTauri()) return;
  const { info } = await import("@tauri-apps/plugin-log");
  await info(`[audio] restarted output after ${reason}`);
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
