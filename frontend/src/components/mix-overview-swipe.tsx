"use client";

interface MixOverviewSwipeProps {
  /** Out-going (old) track waveform. */
  oldContent: React.ReactNode;
  /** Incoming (new) track waveform. */
  newContent: React.ReactNode;
  /** Flipped true at the fade's midpoint to fire the swipe. */
  swipeArmed: boolean;
  /** Out-going track length (s). */
  oldDurationSec: number;
  /** Incoming track length (s). */
  newDurationSec: number;
  /** Where deck A starts fading out (s into the old track). */
  mixOutSec: number;
  /** Where deck B starts playing (s into the new track) — its mix-in point. */
  startOffsetSec: number;
  /** Crossfade length (s). */
  fadeSec: number;
  testId?: string;
}

/** Duration of the swipe itself, in seconds. */
const SWIPE_SEC = 0.5;
const EASE = "cubic-bezier(0.65, 0, 0.35, 1)";

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * The full-track overview during a crossfade, laid out **to scale** from the
 * real durations + mix points. Two layers, each anchored on the shared mix
 * moment (old mix-out == new mix-in) and each animating `translateX` + `scaleX`
 * about its own mix point.
 *
 * - **Before the swipe** both tracks are drawn at the **old track's scale**
 *   (`s = 1 / oldFinish`, `oldFinish = mixOut + fade` — the old track's audible
 *   end). The old track fills the viewport and finishes at the right edge; the
 *   new track is scaled down to match, so the fade windows line up exactly and
 *   its full-height body sits just off the right edge, hidden. Across the overlap
 *   the new track is the top half, the old the bottom half; the old outro (past
 *   the finish) is clipped off.
 * - **At the fade midpoint** (`swipeArmed`) both slide left while their scales
 *   animate to the **new track's scale** (`1 / newDur`): the new track grows to
 *   its true full length, the old tail rescales in step so the two stay
 *   beat-aligned through the overlap, leaving just the old track's tail trailing
 *   bottom-left.
 *
 * Everything is derived, so it is correct for all mix modes and any duration
 * pairing. Static (no per-frame scroll) — GPU-composited transforms only.
 */
export function MixOverviewSwipe({
  oldContent,
  newContent,
  swipeArmed,
  oldDurationSec,
  newDurationSec,
  mixOutSec,
  startOffsetSec,
  fadeSec,
  testId,
}: MixOverviewSwipeProps) {
  const oldDur = Math.max(oldDurationSec, 0.001);
  const newDur = Math.max(newDurationSec, 0.001);
  const fade = Math.max(fadeSec, 0.001);
  const mixOut = clamp(mixOutSec, 0, oldDur);
  const startOff = clamp(startOffsetSec, 0, newDur);
  const oldFinish = clamp(mixOut + fade, fade, oldDur);

  // Screen positions in viewport units (viewport width == 1), pre-swipe. Both
  // tracks start at the old scale; the shared mix moment is at `anchor`.
  const anchor = mixOut / oldFinish; // old mix-out (and new mix-in), pre-swipe
  const miLocal = startOff / newDur; // new's mix-in, fraction of the new box
  const oldBoxW = oldDur / oldFinish; // old box width (outro overflows the edge)

  // Clip splits, in track-time fractions (scale-free; applied before transform).
  const oldFullEnd = clamp((mixOut / oldDur) * 100, 0, 100); // full → bottom half
  const oldClipEnd = clamp((oldFinish / oldDur) * 100, 0, 100); // clip the outro
  const newTopStart = clamp(miLocal * 100, 0, 100); // hidden → top half
  const newFullStart = clamp(((startOff + fade) / newDur) * 100, 0, 100); // → full

  const oldClip = `polygon(0 0, ${oldFullEnd}% 0, ${oldFullEnd}% 50%, ${oldClipEnd}% 50%, ${oldClipEnd}% 100%, 0 100%)`;
  const newClip = `polygon(${newTopStart}% 0, 100% 0, 100% 100%, ${newFullStart}% 100%, ${newFullStart}% 50%, ${newTopStart}% 50%)`;

  // New layer (DOM = 1 viewport wide, rendered at its own scale). Pre-swipe it is
  // squeezed to the old scale and shifted right so its mix-in sits on the anchor;
  // post-swipe it snaps to scale 1, filling the viewport at its true length.
  const newTransform = swipeArmed
    ? "translateX(0%) scaleX(1)"
    : `translateX(${(anchor - miLocal) * 100}%) scaleX(${newDur / oldFinish})`;

  // Old layer (DOM = `oldBoxW` viewports wide, rendered at the old scale).
  // Pre-swipe it sits in place (finish at the right edge); post-swipe it slides
  // left and rescales to the new scale so its tail stays beat-aligned with the
  // new track (their fade windows keep the same width).
  const oldTransform = swipeArmed
    ? `translateX(${((miLocal - anchor) / oldBoxW) * 100}%) scaleX(${oldFinish / newDur})`
    : "translateX(0%) scaleX(1)";

  return (
    <div data-testid={testId} className="relative h-full overflow-hidden">
      {/* Old track — full height, then bottom half across the overlap. */}
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `${oldBoxW * 100}%`,
          clipPath: oldClip,
          transformOrigin: `${oldFullEnd}% 50%`,
          transform: oldTransform,
          transition: `transform ${SWIPE_SEC}s ${EASE}`,
        }}
      >
        {oldContent}
      </div>
      {/* New track — top half across the overlap, then full height. */}
      <div
        className="absolute inset-y-0 left-0 w-full"
        style={{
          clipPath: newClip,
          transformOrigin: `${newTopStart}% 50%`,
          transform: newTransform,
          transition: `transform ${SWIPE_SEC}s ${EASE}`,
        }}
      >
        {newContent}
      </div>
    </div>
  );
}
