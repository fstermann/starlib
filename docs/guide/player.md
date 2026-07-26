# Player

Every library source is playable. Click the artwork on any row to start a track — the player rail appears at the bottom of the window and stays there as you navigate between pages.

## Transport

| Control | What it does |
|---------|--------------|
| :material-skip-previous: **Previous** (++arrow-left++) | Back to the previous track in the queue |
| :material-play: **Play / Pause** (++space++) | Toggles playback. Ignored while you're typing in a field. |
| **CUE** | CDJ-style cue button — tap to set or recall the cue point, hold to preview from it |
| :material-skip-next: **Next** (++arrow-right++) | Skip to the next queued track |

The right side of the rail shows the track's **BPM** and **key**. With pitching enabled, the original key stays grey next to the pitched value and the semitone shift is shown beneath.

## Waveform

The rail renders the track's waveform with playback position, cue marker, and loop region.

- **Zoom in / out** — scale the waveform around the playhead
- **Show zoomed waveform** — expands a detailed, scrolling view above the rail
- **Loop** — toggle a loop, then halve or double its length with the adjacent buttons
- **Artwork** — expand or collapse the cover art at the left of the rail

Rekordbox tracks render their analysed, colour-coded waveform; local files use cached peaks; SoundCloud tracks stream over HLS.

## Queue

The :material-playlist-music: **queue panel** opens from the rail and lists what's coming up.

- Drag rows by the grip handle to reorder
- Remove a track with the :material-close: button
- Right-click any track row in the library to **Play next** or **Add to queue**

Filtering a view narrows the autoplay queue too — tracks filtered out of the table are dropped from the queue rather than played unexpectedly.

## BPM pitching

The **BPM** control in the rail opens the pitcher: enable it and set a target BPM, and Starlib adjusts the playback rate so the track plays at that tempo (limited to 0.5×–2.0×). The key readout follows the pitch and shows the semitone offset.

If a track has no BPM yet, the pitcher can analyse it on the fly; the result is cached so it's instant next time.

Toggle it from anywhere with the **Enable/Disable target-BPM pitching** command in the [command palette](command-palette.md).

## Auto-mix

The :material-blender-outline: **mix control** blends the current track into the next queued one instead of cutting between them. Turn it on in the popover and pick a mode:

| Mode | What it does | Works with |
|------|--------------|------------|
| **Crossfade** | Plain time crossfade over 1–12 seconds | Every source |
| **Beatgrid** | Bar-aligned blend on the two beatgrids (8, 16, or 32 bars) | Tracks with a beatgrid (Rekordbox analysis) |
| **Beatgrid + EQ** | Beatgrid blend plus a DJ-style bass swap, so the two basslines never clash | Local tracks only |
| **Loop + EQ** | Full mixer transition: loop the outgoing track, blend the incoming one in band-by-band (highs → mids → bass), then fade out underneath | Local tracks only |

**Section-aware** anchoring (on by default) snaps the mix to musical section boundaries — the outgoing track's last section end and the incoming track's end-of-intro — instead of a fixed offset from the end of the file, so stray trailing bars don't smear the transition.

SoundCloud streams can't be EQ'd and never carry a beatgrid, so they fall back to a plain crossfade.

Toggle auto-mix from anywhere with the **Enable/Disable auto-mix** command in the [command palette](command-palette.md).

!!! info "How it works"
    The [Auto-mix crossfade](../technical/auto-mix.md) page in the technical docs covers the mix engine, the strategies, and the transition visualisation in detail.
