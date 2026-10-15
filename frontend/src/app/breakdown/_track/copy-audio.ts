import { copyAudioToClipboard, isTauri } from "@/lib/tauri";
import {
  STEM_NAMES,
  stemLabel,
  type TrackBreakdown,
  type TrackSource,
} from "@/lib/track-breakdown";

import { DRUM_PARTS, ORIGINAL, type LaneName } from "./use-stem-player";

/** The audible lanes, e.g. "Original", "Drums + Bass" or "Kick + Snare". */
export function audibleLanesLabel(
  gains: Record<LaneName, number>,
  features: TrackBreakdown["features"],
): string | null {
  const names = gains[ORIGINAL] > 0 ? ["Original"] : [];
  for (const stem of STEM_NAMES) {
    if (gains[stem] <= 0) continue;
    if (stem !== "drums") {
      names.push(stemLabel(stem, features));
      continue;
    }
    const parts = DRUM_PARTS.filter((part) => gains[part.id] > 0);
    if (parts.length === DRUM_PARTS.length)
      names.push(stemLabel(stem, features));
    else names.push(...parts.map((part) => part.label));
  }
  return names.length > 0 ? names.join(" + ") : null;
}

export function trackName(source: TrackSource, result: TrackBreakdown): string {
  if (source.kind === "soundcloud")
    return result.soundcloud?.title ?? `SoundCloud ${source.id}`;
  const file = source.path.split(/[\\/]/).pop() ?? source.path;
  return file.replace(/\.[^.]+$/, "");
}

/**
 * Put the clip on the clipboard as a file in the desktop app; in a browser,
 * which can't, download it. Returns whether it was copied.
 */
export async function deliverClip(
  wav: Uint8Array<ArrayBuffer>,
  name: string,
): Promise<boolean> {
  if (isTauri()) {
    await copyAudioToClipboard(wav, name);
    return true;
  }
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return false;
}
