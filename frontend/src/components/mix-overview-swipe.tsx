"use client";

interface MixOverviewSwipeProps {
  /** Out-going (old) track waveform. */
  oldContent: React.ReactNode;
  /** Incoming (new) track waveform. */
  newContent: React.ReactNode;
  /** Out-going deck's playhead (0–1 of its track). Drawn inside its layer so
   * the clip + transforms place it correctly through the swipe. */
  oldProgress?: number;
  /** Incoming deck's playhead (0–1 of its track). */
  newProgress?: number;
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
  /** Fade length in the OLD track's own seconds (wall-clock × deck A rate). */
  oldFadeSec: number;
  /** Fade length in the NEW track's own seconds (wall-clock × deck B rate). */
  newFadeSec: number;
  testId?: string;
}

/** Duration of the swipe itself, in seconds. */
const SWIPE_SEC = 0.5;
const EASE = "cubic-bezier(0.65, 0, 0.35, 1)";

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * The full-track overview during a crossfade, laid out **to scale** from the
 * real durations + mix points. Two full-viewport layers, each rendered at its
 * own track's natural scale and animating `translateX` + `scaleX` about its own
 * mix point. Whichever track is the master keeps its natural scale; the other
 * is squeezed so the two fade windows (different lengths in track-seconds when
 * the decks run at different rates) coincide on screen.
 *
 * - **Before the swipe** the OLD track is the master: it renders exactly like
 *   the resting overview (natural scale, untransformed, full height — the
 *   waveform must not change when the fade starts), except the top half across
 *   its fade window `[mixOut, mixOut + oldFade]`, where the new track's fade
 *   window `[startOff, startOff + newFade]` is squeezed in as a top-half
 *   sliver. The rest of the new track is clipped away entirely.
 * - **At the fade midpoint** (`swipeArmed`) the NEW track becomes the master:
 *   it settles at identity (its true full length) while the old layer slides
 *   and rescales so its tail covers exactly the new track's fade window,
 *   trailing bottom-left. The clips animate with the swipe (matched vertex
 *   counts, so the polygons interpolate): the old track's pre-mix-out body and
 *   outro collapse into the tail strip, and the new track's body unfolds from
 *   the sliver to full height — the settled frame is exactly the new track to
 *   scale plus the old tail, identical to the adopted view that replaces it.
 *
 * Everything is derived, so it is correct for all mix modes and any duration
 * pairing. Static (no per-frame scroll) — GPU-composited transforms only.
 */
export function MixOverviewSwipe({
  oldContent,
  newContent,
  oldProgress,
  newProgress,
  swipeArmed,
  oldDurationSec,
  newDurationSec,
  mixOutSec,
  startOffsetSec,
  oldFadeSec,
  newFadeSec,
  testId,
}: MixOverviewSwipeProps) {
  const oldDur = Math.max(oldDurationSec, 0.001);
  const newDur = Math.max(newDurationSec, 0.001);
  const fadeA = Math.max(oldFadeSec, 0.001);
  const fadeB = Math.max(newFadeSec, 0.001);
  const mixOut = clamp(mixOutSec, 0, oldDur);
  const startOff = clamp(startOffsetSec, 0, newDur);

  // Mix points as fractions of each layer's own (natural-scale) box.
  const anchor = mixOut / oldDur; // old mix-out, the shared mix moment pre-swipe
  const miLocal = startOff / newDur; // new mix-in

  // Clip boundaries, in track-time percent (applied before the transform).
  const oldFullEnd = anchor * 100; // full height → bottom half
  const oldAudEnd = clamp(((mixOut + fadeA) / oldDur) * 100, 0, 100); // audible end
  const newTopStart = miLocal * 100; // sliver start
  const newFullStart = clamp(((startOff + fadeB) / newDur) * 100, 0, 100);

  // Old: pre-swipe full height with only the top half notched out across its
  // fade window (the resting waveform, minus where the new track sits). The
  // swipe collapses the body and the outro into the bottom-half tail strip.
  const oldClip = swipeArmed
    ? `polygon(${oldFullEnd}% 50%, ${oldFullEnd}% 50%, ${oldFullEnd}% 50%, ${oldAudEnd}% 50%, ${oldAudEnd}% 50%, ${oldAudEnd}% 50%, ${oldAudEnd}% 100%, ${oldFullEnd}% 100%)`
    : `polygon(0% 0%, ${oldFullEnd}% 0%, ${oldFullEnd}% 50%, ${oldAudEnd}% 50%, ${oldAudEnd}% 0%, 100% 0%, 100% 100%, 0% 100%)`;
  // New: pre-swipe only its fade window, as a top-half sliver (body hidden so
  // it can't cover the old track's outro). The swipe unfolds it to full height
  // everywhere except the bottom half under the old tail.
  const newClip = swipeArmed
    ? `polygon(0% 0%, 100% 0%, 100% 100%, ${newFullStart}% 100%, ${newFullStart}% 50%, ${newTopStart}% 50%, ${newTopStart}% 100%, 0% 100%)`
    : `polygon(${newTopStart}% 0%, ${newFullStart}% 0%, ${newFullStart}% 50%, ${newFullStart}% 50%, ${newFullStart}% 50%, ${newTopStart}% 50%, ${newTopStart}% 50%, ${newTopStart}% 50%)`;

  // The squeeze factor mapping one track's fade window onto the other's: the
  // windows cover the same wall-clock (and, beat-matched, the same bars) but
  // different track-seconds when the deck rates differ.
  const newTransform = swipeArmed
    ? "translateX(0%) scaleX(1)"
    : `translateX(${(anchor - miLocal) * 100}%) scaleX(${(fadeA * newDur) / (fadeB * oldDur)})`;
  const oldTransform = swipeArmed
    ? `translateX(${(miLocal - anchor) * 100}%) scaleX(${(fadeB * oldDur) / (fadeA * newDur)})`
    : "translateX(0%) scaleX(1)";

  // Half-split divider across the overlap (mirrors the zoom strip's): the two
  // decks above/below it play separately. Pre-swipe the overlap sits on the
  // old track's fade window; post-swipe on the new track's — the divider
  // sweeps between them with the layers.
  const dividerLeft = swipeArmed ? newTopStart : oldFullEnd;
  const dividerRight = swipeArmed ? newFullStart : oldAudEnd;

  return (
    <div data-testid={testId} className="relative h-full overflow-hidden">
      {/* Old track — natural scale pre-swipe, tail squeezed onto the new
          track's fade window post-swipe. */}
      <div
        className="absolute inset-y-0 left-0 w-full"
        style={{
          clipPath: oldClip,
          transformOrigin: `${oldFullEnd}% 50%`,
          transform: oldTransform,
          transition: `transform ${SWIPE_SEC}s ${EASE}, clip-path ${SWIPE_SEC}s ${EASE}`,
        }}
      >
        {oldContent}
        {oldProgress != null && (
          <div
            data-testid="player-overview-playhead-old"
            className="bg-primary absolute inset-y-0 w-0.5"
            style={{ left: `${clamp(oldProgress, 0, 1) * 100}%` }}
          />
        )}
      </div>
      {/* New track — fade-window sliver pre-swipe, full track at identity
          post-swipe. */}
      <div
        className="absolute inset-y-0 left-0 w-full"
        style={{
          clipPath: newClip,
          transformOrigin: `${newTopStart}% 50%`,
          transform: newTransform,
          transition: `transform ${SWIPE_SEC}s ${EASE}, clip-path ${SWIPE_SEC}s ${EASE}`,
        }}
      >
        {newContent}
        {newProgress != null && (
          <div
            data-testid="player-overview-playhead-new"
            className="bg-primary absolute inset-y-0 w-0.5"
            style={{ left: `${clamp(newProgress, 0, 1) * 100}%` }}
          />
        )}
      </div>
      {dividerRight > dividerLeft && (
        <div
          data-testid="player-overview-split-divider"
          className="bg-primary pointer-events-none absolute top-1/2 h-0.5 -translate-y-1/2"
          style={{
            left: `${dividerLeft}%`,
            width: `${dividerRight - dividerLeft}%`,
            transition: `left ${SWIPE_SEC}s ${EASE}, width ${SWIPE_SEC}s ${EASE}`,
          }}
        />
      )}
    </div>
  );
}
