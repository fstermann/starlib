"use client";

import { Copy, Repeat, RotateCcw } from "lucide-react";

import { useCommand } from "@/components/command-palette/use-command";

/**
 * Palette commands while a Track Breakdown is open. Documented in
 * `docs/guide/command-palette.md` and gated in
 * `frontend/e2e/command-palette-catalog.spec.ts`.
 */
export function TrackCommands({
  sectionsEdited,
  looping,
  onLoop,
  canCopyAudio,
  onCopyAudio,
  onResetSections,
}: {
  sectionsEdited: boolean;
  looping: boolean;
  onLoop: () => void;
  canCopyAudio: boolean;
  onCopyAudio: () => void;
  onResetSections: () => void;
}) {
  useCommand({
    id: "breakdown.track.loop-section",
    label: looping ? "Stop looping" : "Start looping",
    description:
      "Loop the selected bars, or the section under the playhead, synced across all stems.",
    icon: Repeat,
    keywords: ["loop", "repeat", "section", "stems"],
    group: "Breakdown",
    run: ({ close }) => {
      onLoop();
      close();
    },
  });

  useCommand({
    id: "breakdown.track.copy-audio",
    label: "Copy loop audio",
    description:
      "Copy the looped bars with the lanes you hear, mixed, to paste into Ableton.",
    icon: Copy,
    keywords: ["copy", "audio", "clip", "sample", "stems", "ableton", "export"],
    group: "Breakdown",
    when: canCopyAudio,
    run: ({ close }) => {
      onCopyAudio();
      close();
    },
  });

  useCommand({
    id: "breakdown.track.reset-sections",
    label: "Reset sections to detected",
    description:
      "Drop your section edits and go back to the detected sections.",
    icon: RotateCcw,
    keywords: ["reset", "sections", "undo", "detected"],
    group: "Breakdown",
    when: sectionsEdited,
    run: ({ close }) => {
      onResetSections();
      close();
    },
  });

  return null;
}
