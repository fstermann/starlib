"use client";

import { AudioWaveform, ClipboardPaste, Download, Repeat } from "lucide-react";

import { useCommand } from "@/components/command-palette/use-command";

import type { AnalyserUiState } from "../_state";

interface CommandsProps {
  state: AnalyserUiState;
  hasJob: boolean;
  onPasteUrl: () => void;
  onReanalyseSelection: () => void;
  onExportTracklist: () => void;
}

/**
 * Mounts the analyser-feature palette commands while the page is rendered.
 * Each useCommand auto-unregisters on unmount so commands disappear when
 * the user navigates away.
 *
 * Documented in `docs/guide/command-palette.md` and gated in
 * `frontend/e2e/command-palette-catalog.spec.ts`.
 */
export function AnalyserCommands({
  state,
  hasJob,
  onPasteUrl,
  onReanalyseSelection,
  onExportTracklist,
}: CommandsProps) {
  // analyser.open is registered globally by the nav-config "Go to" entry,
  // so it lives in the palette even when the analyser route isn't mounted.
  // The other three only make sense while we're on /analyser, so they live
  // here.

  useCommand({
    id: "analyser.paste-url",
    label: "Analyse SoundCloud URL from clipboard",
    description: "Paste a SoundCloud URL and start a new analyser job.",
    icon: ClipboardPaste,
    keywords: ["paste", "set", "soundcloud", "analyse"],
    group: "Analyser",
    run: ({ close }) => {
      onPasteUrl();
      close();
    },
  });

  useCommand({
    id: "analyser.reanalyse-selection",
    label: "Re-analyse selected region",
    description:
      "Re-run BPM + Shazam over the currently selected timeline region.",
    icon: Repeat,
    keywords: ["re-analyse", "section", "fix", "retry"],
    group: "Analyser",
    when: hasJob && state.selection !== null,
    run: ({ close }) => {
      onReanalyseSelection();
      close();
    },
  });

  useCommand({
    id: "analyser.export-tracklist",
    label: "Export detected tracklist",
    description: "Download the current detected tracklist as a text file.",
    icon: Download,
    keywords: ["export", "tracklist", "download", "txt", "csv"],
    group: "Analyser",
    when: hasJob,
    run: ({ close }) => {
      onExportTracklist();
      close();
    },
  });

  // Suppress unused-icon warnings.
  void AudioWaveform;

  return null;
}
