# Auto-mix crossfade

Starlib's bottom player can automatically crossfade from the playing track into
the next queued one when the current track nears its end. It works for every
source (local files and SoundCloud streams) and its waveform display splits to
show both tracks through the transition.

The controls live in the player rail (the `Blend` popover, `mix-controls.tsx`);
the config is persisted in the UI store under `MIX_CONFIG_KEY`.

## Mix modes

The mode-specific logic is a pure strategy layer in `src/lib/mix/strategies.ts`.
`planTransition(ctx)` returns a `TransitionPlan` — the whole engine and the
waveform visualization read from that plan, so adding a mode is a matter of
adding a strategy, not touching playback or UI.

| Mode | What it does |
|------|--------------|
| `crossfade` | Time crossfade, 1–12 s. `mixOut = duration − fade`, `startOffset = 0`. |
| `beatgrid` | Bar-aligned blend on the beatgrids. Mix-out and mix-in land on **downbeats**, section-aware so the fade doesn't strand a stray couple of bars at the track ends. The variant is picked by the BPM pitcher (`beatSync` in the `TransitionContext`): with pitch/"BPM mode" **on**, both decks are locked to the target BPM for the whole fade; with it **off**, the pitcher target is ignored and the incoming track wins: deck B starts pitched to match deck A's current tempo, then both ramp to deck B's own tempo across the fade (deck A bends to meet it; deck B lands at its natural rate), leaving the pitcher untouched (`rateRamp` on the plan). |
| `beatgrid-eq` | The `beatgrid` blend plus a DJ-style **bass swap** (`eqSwap` on the plan). Identical planning (same downbeat anchoring, section-awareness, and `beatSync` variants), with an extra low-shelf automation so the two basslines never clash. See below. |
| `loop-eq` | A full DJ-mixer transition (`loopEq` on the plan): **loop** deck A's first 4 bars, blend deck B in **band-by-band** with a 3-band EQ (highs → mids → bass hard-swap) over `matchBars` bars, then **fade deck A out** underneath over another `matchBars` bars. Local decks only. See below. |

`TransitionPlan` fields that matter downstream:

- `fadeSeconds` — fade length, in **deck A real-time seconds**.
- `deckAMixOutSec` — where deck A starts fading (seconds into the old track).
- `deckBStartOffsetSec` — where deck B starts playing (seconds into the new
  track); its mix-in point. `0` for `crossfade`, a downbeat for `beatgrid`.

If a track lacks a beatgrid, the `beatgrid` (and `beatgrid-eq`) mode falls back
to `crossfade`.

### Bass EQ handover (`beatgrid-eq`)

`beatgrid-eq` mirrors a mixer's EQ kill so the outgoing and incoming basslines
never play over each other. Each local deck carries a neutral (0 dB) low-shelf
(`BiquadFilterNode` at 250 Hz) spliced after its output gain in
`LoopingWebAudioPlayer` — flat during ordinary play, exposed as
`getBassParam()`. The plan adds `eqSwap` with two fade-relative times (deck A
real-time seconds):

- `deckAKillSec` — the out-going deck's bass kills `EQ_KILL_BARS` (2) bars
  before the fade ends;
- `deckBRestoreSec` — the incoming deck's bass returns `EQ_RESTORE_LEAD_BEATS`
  (1) beat before the fade ends.

Both are computed from the actual bar count of the mix-out window (exact under
beat-sync's constant tempo; approximate during a rate ramp, like the rest of the
ramp variant's grid drift). So the sequence is: the incoming deck's bass is held
down (−40 dB) for the **whole** fade while the out-going deck keeps its bass; 2
bars before the end the out-going bass kills too (~2 bars run **bass-free**);
then the incoming bassline slams in **1 beat before** the final downbeat. The
lead matters: landing the bass exactly on the downbeat makes that kick land
bass-light (reads as late) and puts the drop on the same instant as the adoption
seam (the queue-advance + player rebuild) — a beat early makes the downbeat kick
punch and clears the rebuild.

The engine (`runTransition`) slams each step over a ~30 ms ramp that *finishes*
on its target time (not starts there, so the bass is full **on** the beat) and
bookkeeps them like the fade clock — `pause()`/`resume()` freeze and re-schedule both,
`finish()` (skip) lands on the end state (out-going killed, incoming full) so
deck B is adopted with full bass, and a rescue `cancel()` restores deck A's bass.
**Element (SoundCloud) decks bypass the Web Audio graph** (see `html-deck.ts`),
so their `bassParam()` is null and the EQ is a no-op on that deck — the gain
crossfade still runs.

### Loop + EQ blend (`loop-eq`)

`loop-eq` mimics a full mixer transition. It is a **single long transition** of
`2 × matchBars` bars in two phases, run by a dedicated `runLoopEqTransition` in
`engine.ts` (the other modes share `runTransition`); deck B is adopted at the
very end, so deck A stays engine-owned — looping and fading — through the whole
event without any teardown rework.

Each local deck carries a 3-band EQ in `LoopingWebAudioPlayer` (low-shelf 250 Hz
→ peaking 1 kHz → high-shelf 4 kHz, all neutral in normal play; `getBassParam`
/`getMidParam`/`getHighParam`), plus the existing `setLoop`. The `loopEq` plan
field carries the two phase lengths, deck A's 4-bar `loopRegion`, the per-band
ramp windows, and the bass swap times.

- **Phase 1 — transition (`matchBars` bars):** deck A holds full volume and
  **loops its first 4 bars**; deck B fades in. The bands blend staggered
  (12 o'clock = 0 dB, 10 o'clock ≈ −9 dB): highs then mids dip on A / open on B
  over the first two thirds; the **bass hard-swaps** near the end (A kills 2 bars
  before the point, B slams in 1 beat before it — the finish-on-the-beat ramp
  from `beatgrid-eq`). At the transition point deck B is full (12 o'clock,
  100%) across all bands — the drop.
- **Phase 2 — outro (`matchBars` bars):** deck A **fades its volume out**
  underneath (still looping) while deck B plays full.

`onMidpoint` fires at the transition point (`mixPastMid` → the rail info and
phrase band swap to deck B). `pause/resume/finish/cancel` re-schedule the whole
two-phase automation off a single `elapsedTotal`; `cancel` (rescue) clears deck
A's loop and restores it. A **mid-flight join** (`elapsedSec`) works like
`runTransition`'s: deck B cues that far past its mix-in and deck A is placed at
the **matching phase inside its loop** (a seek can leave it anywhere in the
window — even past the loop end, where the native loop never engages), so the
beats stay locked; the band/gain automation and the clocks run only the
remainder.

**Visualization** is mode-aware (branch on `plan.loopEq`) — the swipe/collapse
model doesn't fit a deck A that plays the whole time. Both surfaces localise the
split + green divider to **deck A's loop region** (the incoming track fills the
rest full height), and the looping deck draws the standard green **loop box**
(`PlayerDetailWaveform`'s `loop` prop) over that region:

- **Zoom strip**: the split window is deck A's loop region, playhead-centred on
  deck A (old bottom half + new top half + divider only there); the loop box is
  passed to the old layer.
- **Overview**: reuses the crossfade squeeze layout with the *loop region* as the
  window. Pre-swipe deck A is full-scale with its loop region bracketed and deck
  B squeezed into it; the **swipe still fires at the transition point** (deck B
  becomes master, deck A collapses to a dimmed looping tail).

The beatgrid mix-out window is anchored by **walking the grid**, not by
arithmetic: take the downbeat at or before the end of musical content (last
section end when section-aware, else the file end), then step `matchBars`
downbeats back. Both ends are actual grid ticks, so the fade ends bar-perfect
at the content end. The earlier subtract-fade-length-then-snap approach was
reliably a bar early: real grids carry per-tick ms rounding, so the subtracted
time landed a hair before the intended downbeat and snapped back a whole bar.
The wall-clock `fadeSeconds` is that grid window divided by deck A's rate
(sync), or by the average of the entry/target rates (ramp).

## Engine + hand-off

`src/lib/mix/engine.ts` runs a **dual-deck** crossfade. Deck B (the incoming
track) is decoded/attached and cued *ahead* of the mix-out point, then
`runTransition()` ramps the two gain nodes (equal-power) and, when the plan
carries a `rateRamp`, the playback rates. The non-mix playback path is untouched, so there is no
regression risk for ordinary play.

**Play/pause during the fade controls both decks.** The `TransitionHandle`
exposes `pause()`/`resume()`: pause stops both decks, holds the gain (and
ramp-mode rate) automation at its current value, and freezes the fade's own
clock — the completion and midpoint timers run on remaining-time bookkeeping,
not wall-clock, so a paused fade can't complete (and advance the queue) in the
background. Resume re-ramps from the held values over the remaining time. While
`mixState === "transitioning"`, the player's `isPlaying` effect routes through
the handle instead of `ws.pause()`/`ws.play()` (which would only touch deck A).
The midpoint callback (`onMidpoint`) drives `mixPastMid` — the side-rail info
swap and the overview swipe — so those also freeze correctly under pause.

**Seeking into the fade window joins the fade mid-flight.** The trigger fires
whenever deck A's playhead reaches the mix-out point — including via a seek
that lands well past it. `runTransition` takes the overshoot (as wall-clock
`elapsedSec`): deck B cues that far past its own mix-in (ramp modes integrate
the rate ramp for its track-time), the gains (and ramp rates) start at their
mid-fade values, and the completion/midpoint clocks run only the remainder —
`onMidpoint` fires synchronously when the join is already past it. So the whole
transition is skippable: a pre-swipe overview click into the fade region
rescues, seeks, re-arms, and the restarted fade rejoins exactly where the click
landed instead of starting deck B back at its mix point.

When the fade completes, deck B is stashed in a small hand-off store
(`stashHandoff`/`takeHandoff`) and the queue advances. The rebuilt player
**adopts** the already-playing deck B instead of re-decoding it — no gap, no
restart. `ws.on("finish")` and every `pause` handler is guarded with
`transitionStartedRef` so the out-going deck reaching its natural end mid-fade
can't fire a second `next()` that would abort the fade.

The adoption seam is flicker-guarded in three ways. The transition visuals are
gated on `mixState === "transitioning" && !transitionCompletedRef.current` —
after the queue advances there is a render where `currentTrack` is already the
adopted track but `mixState` hasn't reset, and without the gate the overlay
and split would flash a bogus next transition for a frame (visible whenever a
third track is queued). The init-effect teardown reports the **adopted deck's
live progress/duration** instead of zeroes, so progress subscribers don't
flash back to the track start while the player rebuilds. And the zoom strip
keeps the incoming deck's canvas alive across the seam (see below).

## Waveform visualization during the transition

Two surfaces split while `mixState === "transitioning"`. This was fiddly to get
right; the invariants below are the spec.

Convention: **track 1 = old (out-going), track 2 = new (incoming). New always
takes the top half, old the bottom half.**

### Zoom strip (`player-detail-split`)

The zoomed, scrolling strip splits into two decks overlaid in the same box,
each a full-size waveform clipped to a half. The layers are **keyed by track
path** in a single map (idle renders one layer, a fade renders two), so React
reconciles them across the fade's seams: at adoption the incoming deck's
`PlayerDetailWaveform` is *kept in place* — its canvas, decoded waveform, and
analysis state survive — instead of remounting, which repaints from a blank
canvas and flickers. Through the rebuild the kept layer's `durationSec` is
forced to 0 (draw early-returns, freezing the canvas on its last fade frame)
until the rebuilt player reports real values, so no frame is drawn against the
previous track's stale duration.

- New track → **top half**.
- Old track → **bottom half**.

Each is a `PlayerDetailWaveform` driven by its **own deck's** playhead
(`progressOverride` = deck A / deck B progress). Both are playhead-centred, so
the old tail scrolls out on the bottom as the new head scrolls in on top. There
is **no swipe** here — it just keeps scrolling.

The half split only covers the actual overlap. The clip polygons carry two
moving x boundaries (computed per frame from each deck's window):

- Left of the **new track's mix-in point** (`deckBStartOffsetSec` in deck B's
  window) only the old track is audible → the old track keeps its **full
  height** and the new track (its never-played intro/lead-in) is hidden.
- Right of the **old track's audible end** (`mixOut + fade × rate` in deck A's
  window, capped at its duration) the old track has run out → the new track
  takes the **full height** and the old track is hidden.

A green (`--primary`) horizontal divider line runs along the half split,
spanning exactly the overlap region between the two boundaries — a visual cue
that the two decks above/below it are playing separately. Because it spans
only the split region, it appears and disappears with the split itself.

Over the fade's last stretch (a third of the fade, 0.2–1.5 s) both boundaries
sweep to the left edge, so the new track unfolds to full height *before* the
split unmounts at adoption. Without the sweep the old track's audible end sits
exactly at the playhead centre when the fade completes, and the whole left half
snaps from split to full-new in a single frame.

### Full-track overview (`player-crossfade-overview`, `MixOverviewSwipe`)

The overview is laid out **to scale** from the real durations and the plan's mix
points — never hardcoded — then does a single quick swipe at the fade midpoint.
It is **two independently-transformed layers**, each a full-viewport box at its
own track's natural scale, animating `translateX` + `scaleX` about its own mix
point. The **master track** of each phase keeps its natural scale; the other is
squeezed so the two fade windows coincide on screen. The windows cover the same
wall-clock (and, beat-matched, the same bars) but *different track-seconds* when
the decks run at different rates, so each is measured in its own deck's time:
`oldFade = fade × rateA`, `newFade = fade × rateB`.

- **Before the swipe** the **old track is the master**: its layer is
  untransformed and full height — pixel-identical to the resting overview, so
  nothing stretches or shifts the moment the fade starts. Only the top half
  across its fade window `[mixOut, mixOut + oldFade]` is notched out, where the
  new track's fade window `[startOff, startOff + newFade]` is squeezed in
  (`scaleX = oldFade·newDur / (newFade·oldDur)`) as a **top-half sliver**. The
  rest of the new track is clipped away entirely, so its body can't cover the
  old track's outro.
- **At the midpoint** (`swipeArmed`, driven by `mixPastMid` — the same trigger
  that swaps the side-rail track info) the **new track becomes the master**: it
  settles at identity (its true full length) while the old layer slides left and
  rescales (`scaleX = newFade·oldDur / (oldFade·newDur)`) so its tail covers
  exactly the new track's fade window, trailing bottom-left. The **clip polygons
  animate with the swipe** (both states share a vertex count so they
  interpolate): the old track's pre-mix-out body and outro collapse into the
  bottom-half tail strip, and the new track unfolds from the sliver to full
  height. The settled frame is therefore exactly the new track at its own scale
  plus the old bottom-half tail, pixel-identical to the adopted view that
  replaces it.

Why the old layer rescales onto the *new* track's fade window (not a shared
scale, and never wall-clock seconds on both): post-swipe the new track is the
timeline, and the old tail is only meaningful as "what plays over the new
track's first `newFade` seconds". Drawing the tail at one-second-per-new-second
(the old behavior) stretches it past the new track's mix window whenever the
decks' rates differ. The same reasoning pre-swipe keeps the old track — what
the user has been watching all along — completely untouched while the new
track adapts to it.

Because every measurement comes from `TransitionPlan` + the two durations, the
layout is correct for **all** mix modes and any duration pairing: a 6 s fade on a
5-minute track shows a thin overlap sliver near the end; a short new track lands
at its true (shorter) length, not stretched to the old track's.

The overlay renders its waveform strip at the same `h-8` height (vertically
centred) as the resting overview waveform, so entering/leaving a transition
never changes the waveform's size — the overlay's full-row opaque box exists
only to hide the base waveform and markers beneath it.

**Playheads, cues + navigation during the fade.** Each layer draws its own
deck's playhead line *inside* the transformed layer (a `left: progress%`
element), so the clip and swipe transforms place it correctly in both phases.
Each layer also draws its own track's **hot/memory cue pips** the same way
(display-only — the overlay's click handler owns navigation); without them the
opaque overlay would hide the base overview's markers for the whole fade. The
overlay is clickable: **before the swipe** the view is the old track at its
natural scale and a click is a rescue — the fade is cancelled (deck A restored
to full gain and its pitched rate, deck B discarded), the old track jumps to
the clicked time, and the prepare effect re-arms (via a `rearmTick` bump) so
the mix fires again on the next pass over the mix-out point. **After the
swipe** the view is the incoming track at its true scale, and the click maps
to a deck-B time. Inside the fade window the whole fade is **re-timed** to
that moment: deck A is repositioned to the matching point (`mixOut + elapsed ×
rateA` — or, for loop-eq, the matching phase inside its loop, handled by the
relaunched runner), the running handle is cancelled and relaunched with the
new `elapsedSec`, and `mixPastMid` is recomputed (a click back into the first
half reverses the swipe and re-fires it at the new midpoint). Outside the
window (deck B's body, or its never-played intro) the old track has no
business playing on — deck B cues there and the handle **finishes**
immediately: a quick 0.15 s ramp to the end states, then the normal
completion/adoption path.

The **phrase band** (section labels under the overview) tracks what the
overview shows: the old track's sections until the swipe, the incoming track's
sections (over its duration) from the swipe on and through the adoption seam.
The prepare effect stores the incoming track's analysis (`nextAnalysis`) for
this.

Once the fade completes and deck B is adopted, the overlay is dropped and the new
track's own full-width waveform renders normally.

## Tests

`frontend/e2e/crossfade.spec.ts` drives the whole flow offline: enabling
auto-mix, reaching the mix-out point, asserting the transition state, the
incoming-track chip, the split overview + zoom strip, the Rekordbox-style
overlay, and adoption of the next track. Strategy planning is unit-tested in
`src/lib/mix/strategies.test.ts`.
