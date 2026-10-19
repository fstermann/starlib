/**
 * Route a media element through the shared Web Audio context: a peaking
 * filter (the EQ preview) then a gain (A/B switching and level matching).
 * The element plays through untouched until something asks for its output.
 */

import { getSharedAudioContext } from "./looping-web-audio-player";

export interface MediaOutput {
  filter: BiquadFilterNode;
  gain: GainNode;
}

// Parameter changes glide over this long so they don't click.
const GLIDE_S = 0.01;

// An element can feed only one source node, ever; keep its chain for later use.
const outputs = new WeakMap<HTMLMediaElement, MediaOutput>();

export function hasOutput(media: HTMLMediaElement): boolean {
  return outputs.has(media);
}

/** The element's filter and gain, routing it through them on first use. */
export function outputFor(media: HTMLMediaElement): MediaOutput {
  const existing = outputs.get(media);
  if (existing) return existing;
  const ctx = getSharedAudioContext();
  const filter = ctx.createBiquadFilter();
  filter.type = "peaking";
  filter.gain.value = 0;
  const gain = ctx.createGain();
  ctx
    .createMediaElementSource(media)
    .connect(filter)
    .connect(gain)
    .connect(ctx.destination);
  // Once routed, the element is heard only while the context runs.
  media.addEventListener("play", () => void ctx.resume().catch(() => {}));
  void ctx.resume().catch(() => {});
  const output = { filter, gain };
  outputs.set(media, output);
  return output;
}

/** Glide ``param`` to ``value`` with time constant ``seconds``. */
export function glide(
  param: AudioParam,
  value: number,
  seconds = GLIDE_S,
): void {
  param.setTargetAtTime(value, getSharedAudioContext().currentTime, seconds);
}
