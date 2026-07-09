"use client";

import { useEffect, useState } from "react";

import { getSetting, setSetting, type WaveformStyle } from "@/lib/settings";

/** Dispatched on `window` when the waveform style changes, for live sync
 * across the settings dialog and every mounted player/waveform. */
export const WAVEFORM_STYLE_EVENT = "waveform-style-changed";

/** Persist a new waveform style and notify listeners in the same tab. */
export async function saveWaveformStyle(style: WaveformStyle): Promise<void> {
  await setSetting("waveformStyle", style);
  window.dispatchEvent(
    new CustomEvent<WaveformStyle>(WAVEFORM_STYLE_EVENT, { detail: style }),
  );
}

/**
 * Read the current waveform style, kept in sync via {@link WAVEFORM_STYLE_EVENT}.
 * Returns the default (`"starlib"`) until the async store load resolves.
 */
export function useWaveformStyle(): WaveformStyle {
  const [style, setStyle] = useState<WaveformStyle>("starlib");

  useEffect(() => {
    let cancelled = false;
    getSetting("waveformStyle")
      .then((s) => {
        if (!cancelled) setStyle(s);
      })
      .catch(() => {});
    const onChange = (e: Event) => {
      setStyle((e as CustomEvent<WaveformStyle>).detail);
    };
    window.addEventListener(WAVEFORM_STYLE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(WAVEFORM_STYLE_EVENT, onChange);
    };
  }, []);

  return style;
}
