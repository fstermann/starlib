/**
 * SoundCloud/HLS deck for the mix engine. Wraps an `HTMLAudioElement` and
 * routes it through a `MediaElementAudioSourceNode → GainNode` in the shared
 * `AudioContext` so its level can be crossfaded like a Web Audio deck.
 *
 * A `MediaElementAudioSourceNode` can be created from an element **once** for
 * the lifetime of that element, so the wrapper is created together with a fresh
 * element (incoming deck B) or once, lazily, over the player's existing element
 * (out-going deck A). The gain routing survives WaveSurfer adopting the element
 * afterwards — WaveSurfer drives an `HTMLMediaElement` directly and never
 * touches the Web Audio graph.
 */

import Hls from "hls.js";

import { getSharedAudioContext } from "@/lib/looping-web-audio-player";

export interface HtmlGainRoute {
  gainParam: AudioParam;
  /** Disconnect the source/gain nodes (element playback is left untouched). */
  dispose: () => void;
}

/** Route an existing, playing element through a gain node. Idempotent-guarded
 * by the caller (an element may only be sourced once). */
export function routeElementThroughGain(
  audio: HTMLMediaElement,
  initialGain = 1,
): HtmlGainRoute {
  const ctx = getSharedAudioContext();
  const source = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  gain.gain.value = initialGain;
  source.connect(gain);
  gain.connect(ctx.destination);
  return {
    gainParam: gain.gain,
    dispose: () => {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}

function isHlsUrl(url: string): boolean {
  const noQuery = url.split("?")[0] ?? url;
  return noQuery.endsWith(".m3u8");
}

export interface HtmlDeckSource {
  audio: HTMLAudioElement;
  route: HtmlGainRoute;
  hls: Hls | null;
  /** Duration once known (seconds), else 0. */
  duration: number;
}

/**
 * Create a fresh, DOM-attached audio element for an incoming SoundCloud track,
 * routed through a gain node (starting silent). Resolves once metadata lands so
 * the caller has a finite duration. Playback is the caller's responsibility.
 */
export async function createHtmlDeck(
  url: string,
  initialGain = 0,
): Promise<HtmlDeckSource> {
  const audio = new Audio();
  audio.preload = "auto";
  audio.hidden = true;
  audio.crossOrigin = "anonymous";
  document.body.appendChild(audio);

  const route = routeElementThroughGain(audio, initialGain);

  let hls: Hls | null = null;
  if (isHlsUrl(url) && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else {
    audio.src = url;
  }

  await new Promise<void>((resolve) => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      resolve();
      return;
    }
    const done = () => {
      audio.removeEventListener("loadedmetadata", done);
      audio.removeEventListener("durationchange", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    audio.addEventListener("loadedmetadata", done);
    audio.addEventListener("durationchange", done);
    audio.addEventListener("error", done, { once: true });
  });

  return {
    audio,
    route,
    hls,
    duration: isFinite(audio.duration) ? audio.duration : 0,
  };
}
