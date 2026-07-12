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
| `simple` | Time crossfade, 1–12 s. `mixOut = duration − fade`, `startOffset = 0`. |
| `beatmatch-sync` | Both decks pitched to the same BPM (needs pitch/"BPM mode" on, else falls back to `simple`). Mix-out and mix-in snap to **downbeats**, section-aware so the fade doesn't strand a stray couple of bars at the track ends. |
| `beatmatch-ramp` | Deck A plays at its own tempo; deck B starts pitched to match, then both ramp to the target BPM across the fade. |

`TransitionPlan` fields that matter downstream:

- `fadeSeconds` — fade length, in **deck A real-time seconds**.
- `deckAMixOutSec` — where deck A starts fading (seconds into the old track).
- `deckBStartOffsetSec` — where deck B starts playing (seconds into the new
  track); its mix-in point. `0` for `simple`, a downbeat for the beatmatch modes.

If a track lacks a beatgrid, the beatmatch modes fall back to `simple`.

## Engine + hand-off

`src/lib/mix/engine.ts` runs a **dual-deck** crossfade. Deck B (the incoming
track) is decoded/attached and cued *ahead* of the mix-out point, then
`runTransition()` ramps the two gain nodes (equal-power) and, for `beatmatch-ramp`,
the playback rates. The non-mix playback path is untouched, so there is no
regression risk for ordinary play.

When the fade completes, deck B is stashed in a small hand-off store
(`stashHandoff`/`takeHandoff`) and the queue advances. The rebuilt player
**adopts** the already-playing deck B instead of re-decoding it — no gap, no
restart. `ws.on("finish")` and every `pause` handler is guarded with
`transitionStartedRef` so the out-going deck reaching its natural end mid-fade
can't fire a second `next()` that would abort the fade.

## Waveform visualization during the transition

Two surfaces split while `mixState === "transitioning"`. This was fiddly to get
right; the invariants below are the spec.

Convention: **track 1 = old (out-going), track 2 = new (incoming). New always
takes the top half, old the bottom half.**

### Zoom strip (`player-detail-split`)

The zoomed, scrolling strip splits into two decks overlaid in the same box
(`MixSplitWaveform`), each a full-size waveform clipped to a half:

- New track → **top half** (`clip-path: inset(0 0 50% 0)`).
- Old track → **bottom half** (`clip-path: inset(50% 0 0 0)`).

Each is a `PlayerDetailWaveform` driven by its **own deck's** playhead
(`progressOverride` = deck A / deck B progress). Both are playhead-centred, so
the old tail scrolls out on the bottom as the new head scrolls in on top. There
is **no swipe** here — it just keeps scrolling.

### Full-track overview (`player-crossfade-overview`, `MixOverviewSwipe`)

The overview is laid out **to scale** from the real durations and the plan's mix
points — never hardcoded — then does a single quick swipe at the fade midpoint.
It is **two independently-transformed layers**, both anchored on the shared mix
moment (old mix-out == new mix-in, `anchor = mixOut / oldFinish` where
`oldFinish = mixOut + fade` is the old track's **audible** end — a downbeat that
can precede the track's own end, with an outro after).

Both layers animate `translateX` + `scaleX` about their own mix point.

- **Before the swipe** both tracks are drawn at the **old track's scale**
  (`s = 1 / oldFinish`). The old layer fills the viewport and finishes at the
  right edge (its box is `oldDur / oldFinish` viewports wide; the outro overflows
  and is clipped). The new layer is `scaleX`-ed *down* to that same scale
  (`newDur / oldFinish`) and shifted right, so the two fade windows line up
  exactly and the new track's full-height body sits just off the right edge,
  hidden. Old clips to the **bottom half** across the overlap, new to the **top
  half**.
- **At the midpoint** (`swipeArmed`, driven by `mixPastMid` — the same trigger
  that swaps the side-rail track info) both layers slide left while their scales
  animate to the **new track's scale** (`1 / newDur`): the new track grows to its
  **true full length**, and the old tail rescales in step, leaving just the old
  track's tail trailing bottom-left.

Why both scales animate (not a single shared scale, and not only the new layer):
a single shared scale draws the new track at the *old* track's scale, so a
shorter new track only half-fills the viewport after the swipe. Scaling **only**
the new layer fixes its length but leaves the two tracks at different scales
post-swipe — their fade windows (same beats, this is a beat-matched mix) end up
different widths and drift apart after the mix point. Animating **both** to the
new scale keeps the overlap beat-aligned *and* gives the new track its true
length. A pure translate can't do either, since it can't reconcile two
time-scales.

Because every measurement comes from `TransitionPlan` + the two durations, the
layout is correct for **all** mix modes and any duration pairing: a 6 s fade on a
5-minute track shows a thin overlap sliver near the end; a short new track lands
at its true (shorter) length, not stretched to the old track's.

Once the fade completes and deck B is adopted, the overlay is dropped and the new
track's own full-width waveform renders normally.

## Tests

`frontend/e2e/crossfade.spec.ts` drives the whole flow offline: enabling
auto-mix, reaching the mix-out point, asserting the transition state, the
incoming-track chip, the split overview + zoom strip, the Rekordbox-style
overlay, and adoption of the next track. Strategy planning is unit-tested in
`src/lib/mix/strategies.test.ts`.
