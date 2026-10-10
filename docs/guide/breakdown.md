# Breakdown

Breakdown has two views, switched with the **Set / Track** toggle at the top left.

- **Set** finds the tracks in a SoundCloud DJ set: BPM per window, sections, Shazam matches and a tracklist.
- **Track** takes one track from your collection apart so you can study its arrangement.

## Track view

Open a track with **Open in Breakdown** in the library row's right-click menu, the **Open selected track in Breakdown** palette command, or the search box on the Track view.

**Recent** under the search box lists the tracks you've opened, newest first. A track whose file moved is greyed out. The trash button deletes its stems, measurements and section edits; the audio file stays.

The first analysis separates the track into stems and splits the drums, which takes about a minute on Apple Silicon. Results are cached by the track's audio, so editing its tags doesn't trigger a new analysis. You can cancel while it runs.

### What you see

| Lane | Shows |
|------|-------|
| Bar | Bar numbers and times. Beat ticks appear when zoomed to 8 bars or fewer. When zoomed to 16 bars or fewer, the waveforms get beat lines, and 16th-note lines once there's room: use them to see where the kick sits and what the bass leaves free. |
| Sections | Detected sections, coloured by type. Click one to jump to it. |
| Original | The full mix, drawn from the stems summed back together: peaks in the outer shade, loudness (RMS) in the inner one. Sharp down to a single bar. |
| Loudness, Width, Brightness | Mix level (solid), stereo width as side over mid power (dashed) and spectral centroid (dotted) per bar. Click a name to hide its line. |
| Drums, Bass, Other, Vocals / FX | Waveform of each stem in its own colour, all on the same scale so a quiet stem looks quiet. A muted lane, or one silenced by another lane's solo, is greyed out. A mostly silent vocals stem is labelled **FX / shots**, since on instrumentals it picks up mid-range hits and effects. |
| Kick, Snare, Hats | Click the arrow next to **Drums** to show the drum stem split into kick, snare and claps, and hats and cymbals. Each part has its own waveform, mute, solo and volume; solo **Kick** to hear the kick alone. Toms play with the kick. The parts come from a second separation model, so expect some bleed between them. |

The header shows tempo, root note (from the strongest bass peak), bar count and where bar 1 starts.

Stems are machine-separated and approximate. Expect some bleed between lanes.

Below the lanes, **Spectrum** shows a live frequency analysis of what you hear, like an EQ plugin's analyser. It follows mute and solo, so soloing the bass shows the bass spectrum.

### Playing stems

All lanes play sample-locked to each other. Each lane has **M** (mute), **S** (solo) and a volume slider. The original starts muted; solo it to compare against the stems.

- ++space++ plays and pauses.
- **Loop section** loops the section under the playhead.
- **Track / 32 bars / 8 bars / 1 bar** set the zoom. ++cmd++ + scroll zooms around the pointer; a horizontal scroll pans.
- Click the strip above the lanes to move the visible window.

### Editing sections

Labels are a first guess. Edits are saved per track.

- Drag the edge between two sections to move the boundary.
- Double-click a section to rename it.
- Right-click a section to split it at the clicked bar, merge it with the next one, or loop it.
- The reset button next to **Sections** returns to the detected sections.

### Correcting the bar grid

Bar 1 is assumed to start on the first kick, which holds for DJ-oriented tracks. If it doesn't, click **Bar 1** in the header, correct the tempo or nudge the downbeat, then **Re-measure**. Stems are reused, so this takes a few seconds.

## Setup

Stem separation uses [Demucs](https://github.com/facebookresearch/demucs) with the `htdemucs` model, and [DrumSep](https://github.com/inagoy/drumsep) to split the drums. It needs PyTorch, which is too large to bundle, so the app sets it up on first use: click **Set up stem separation** in the Track view or under **Settings > Breakdown**. It downloads about 1 GB once (Python, PyTorch, Demucs and both models) and takes about a minute. No Python or Homebrew install is needed. **Remove** in the same place frees the space again.

Stems are FLAC, about 110 MB per six-minute track plus the drum parts. **Stems folder** in Settings > Breakdown moves them out of the app cache.

Track view works on files inside your music root folder. SoundCloud tracks aren't supported.
