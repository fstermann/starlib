"use client";

import { Repeat, RotateCcw } from "lucide-react";

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
  onResetSections,
}: {
  sectionsEdited: boolean;
  looping: boolean;
  onLoop: () => void;
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
