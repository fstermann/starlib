/**
 * SoundCloud/HLS deck for the mix engine. Wraps an `HTMLAudioElement` and
 * fades it by automating `element.volume` directly.
 *
 * Element decks deliberately do NOT go through the Web Audio graph
 * (`MediaElementAudioSourceNode → GainNode`): WebKit — Tauri's WKWebView and
 * Safari — never captures an MSE-backed element (hls.js) into the graph, so a
 * gain ramp there controls silence while the element keeps playing at full
 * volume. `element.volume` is honored by every engine, and an element can be
 * faded any number of times (no once-per-element source-node restriction).
 */

import Hls from "hls.js";

/**
 * The `AudioParam` automation surface the mix engine drives. A real
 * `AudioParam` (local Web Audio decks) satisfies it structurally; element
 * decks implement it with a timer over `element.volume`.
 */
export interface GainParamLike {
  value: number;
  cancelScheduledValues(startTime: number): void;
  setValueAtTime(value: number, startTime: number): void;
  setValueCurveAtTime(
    values: Float32Array | number[],
    startTime: number,
    duration: number,
  ): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
}

export interface HtmlGainRoute {
  gainParam: GainParamLike;
  /** Stop any running automation (the element's current volume is kept). */
  dispose: () => void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Drive `audio.volume` through the engine's `AudioParam`-shaped automation
 * calls. The engine always anchors a ramp with `setValueAtTime(v, now)` right
 * before scheduling it, so ramp durations are derived from the times it passes
 * in — no AudioContext is needed here, and the same element can be re-faded on
 * every transition.
 */
export function createVolumeFade(
  audio: HTMLMediaElement,
  initialVolume = 1,
): HtmlGainRoute {
  audio.volume = clamp01(initialVolume);

  let timer: ReturnType<typeof setInterval> | null = null;
  let endSnap: ReturnType<typeof setTimeout> | null = null;
  // The engine's clock value from the most recent `setValueAtTime`, used to
  // turn a `linearRampToValueAtTime(to, endTime)` into a duration.
  let anchorTime = 0;

  const stop = () => {
    if (timer) clearInterval(timer);
    if (endSnap) clearTimeout(endSnap);
    timer = null;
    endSnap = null;
  };

  const animate = (valueAt: (t: number) => number, duration: number) => {
    stop();
    if (duration <= 0) {
      audio.volume = clamp01(valueAt(0));
      return;
    }
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= duration) {
        audio.volume = clamp01(valueAt(duration));
        stop();
        return;
      }
      audio.volume = clamp01(valueAt(t));
    };
    timer = setInterval(tick, 16);
    // Background tabs throttle intervals — make sure the end value still lands
    // when the fade's engine timers (setTimeout) complete on schedule.
    endSnap = setTimeout(() => {
      audio.volume = clamp01(valueAt(duration));
      stop();
    }, duration * 1000);
  };

  const gainParam: GainParamLike = {
    get value() {
      return audio.volume;
    },
    set value(v: number) {
      stop();
      audio.volume = clamp01(v);
    },
    cancelScheduledValues: () => stop(),
    setValueAtTime: (v, startTime) => {
      stop();
      anchorTime = startTime;
      audio.volume = clamp01(v);
    },
    setValueCurveAtTime: (values, _startTime, duration) => {
      const pts = Array.from(values);
      if (pts.length === 0) return;
      if (pts.length === 1) {
        animate(() => pts[0]!, duration);
        return;
      }
      // Piecewise-linear through the curve points, like the AudioParam spec.
      animate((t) => {
        const pos = Math.min(1, t / duration) * (pts.length - 1);
        const i = Math.min(pts.length - 2, Math.floor(pos));
        const frac = pos - i;
        return pts[i]! + (pts[i + 1]! - pts[i]!) * frac;
      }, duration);
    },
    linearRampToValueAtTime: (to, endTime) => {
      const from = audio.volume;
      const duration = Math.max(0, endTime - anchorTime);
      if (duration === 0) {
        stop();
        audio.volume = clamp01(to);
        return;
      }
      animate((t) => from + (to - from) * Math.min(1, t / duration), duration);
    },
  };

  return { gainParam, dispose: stop };
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
 * with a volume fade starting silent. Resolves once metadata lands so the
 * caller has a finite duration. Playback is the caller's responsibility.
 */
export async function createHtmlDeck(
  url: string,
  initialGain = 0,
): Promise<HtmlDeckSource> {
  const audio = new Audio();
  audio.preload = "auto";
  audio.hidden = true;
  document.body.appendChild(audio);

  const route = createVolumeFade(audio, initialGain);

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
