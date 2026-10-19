# Breakdown

Breakdown has two views, switched with the **Set / Track** toggle at the top left.

- **Set** finds the tracks in a DJ set from SoundCloud or a local recording: BPM per window, sections, Shazam matches, a tracklist and loudness.
- **Track** takes one track from your collection or SoundCloud apart so you can study its arrangement.

## Track view

Open a track with **Open in Breakdown** in the library row's right-click menu, the **Open selected track in Breakdown** palette command, or the search box on the Track view. SoundCloud rows in the library and on Weekly have **Open in Breakdown** too: the track downloads first, then is analysed like a local file. A track SoundCloud won't stream can't be broken down.

**Recent** under the search box lists the tracks you've opened, newest first, with SoundCloud ones marked by its logo. A local track whose file moved is greyed out. The trash button deletes its stems, measurements and section edits; the audio file stays.

The first analysis separates the track into stems and splits the drums, which takes about a minute on Apple Silicon. Results are cached by the track's audio, so editing its tags doesn't trigger a new analysis. You can cancel while it runs.

### What you see

| Lane | Shows |
|------|-------|
| Bar | Bar numbers and times. Beat ticks appear when zoomed to 8 bars or fewer. When zoomed to 16 bars or fewer, the waveforms get beat lines, and 16th-note lines once there's room: use them to see where the kick sits and what the bass leaves free. |
| Sections | Detected sections, coloured by type, with their length in bars. Hover for the bar range; click one to jump to it. Bar and Sections stay pinned at the top while the lanes scroll. |
| Original | The full mix, drawn from the stems summed back together: peaks in the outer shade, loudness (RMS) in the inner one. Sharp down to a single bar. |
| Curves | Click the arrow next to **Original** to show loudness, width and brightness under it: mix level (solid), stereo width as side over mid power (dashed) and spectral centroid (dotted) per bar. Click a name to hide its line. |
| Drums, Bass, Other, Vocals / FX | Waveform of each stem in its own colour, all on the same scale so a quiet stem looks quiet. A muted lane, or one silenced by another lane's solo, is greyed out. A mostly silent vocals stem is labelled **FX**, since on instrumentals it picks up mid-range hits and effects. |
| Kick, Snare, Hats | Click the arrow next to **Drums** to show the drum stem split into kick, snare and claps, and hats and cymbals. Each part has its own waveform, mute, solo and volume; solo **Kick** to hear the kick alone. Toms play with the kick. The parts come from a second separation model, so expect some bleed between them. |

The header shows the track's cover, title and artist, then tempo, root note, bar count and length. Hover **Root** for the strongest bass peak it comes from, and **Bars** for where bar 1 starts.

Stems are machine-separated and approximate. Expect some bleed between lanes.

Below the lanes, **Spectrum** shows a live frequency analysis of what you hear, like an EQ plugin's analyser. It follows mute and solo, so soloing the bass shows the bass spectrum. Hover it to read the frequency, nearest note (A4 = 440 Hz, so middle C is C4) and level under the pointer.

### Playing stems

All lanes play sample-locked to each other. Each lane has **M** (mute), **S** (solo) and a volume slider. The original starts muted; solo it to compare against the stems.

- Click a lane to set the cue (the marker in the bar ruler), as in Ableton. ++space++ plays from the cue and, pressed again, stops and returns to it. Clicking while playing jumps there.
- ++shift+space++ pauses and resumes where playback is, without returning to the cue.
- [Headphone sync](player.md#headphone-sync) in the top right also holds the playhead and spectrum back, so they match what you hear over Bluetooth.
- Drag across a lane or the bar ruler to loop those bars, as in Ableton. The loop snaps to bars, or to the grid lines shown when zoomed to 16 bars or fewer: beats, then 16ths once zoomed in far enough to draw them, and sets the cue at its start. The looped bars are tinted across all lanes, with the loop brace along the top of the ruler.
- **Loop** turns looping on and off. Turned off, the brace stays in place, greyed out; click it to loop again. With no loop yet, **Loop** loops the section under the playhead.
- **Copy audio** (++cmd+c++) copies the looped bars as a WAV, mixed from the lanes you hear: solo **Drums** to copy the drums, solo all four stems to copy them summed, unmute the original to copy it. Paste it into Ableton with ++cmd+v++. Clips are saved in `~/Music/Starlib/Clips`, so a set that uses them keeps finding them. In a browser the WAV downloads instead.
- The zoom control at the right shows the whole track (**Fit**), 32, 8 or 1 bar; the magnifier buttons halve or double the visible bars. ++cmd++ + scroll zooms around the pointer; a horizontal scroll pans.
- Click the strip above the lanes to move the visible window.

### Editing sections

Labels are a first guess. Edits are saved per track.

- Drag the edge between two sections to move the boundary.
- Double-click a section to rename it.
- Right-click a section to split it at the clicked bar, merge it with the next one, or loop it.
- The reset button next to **Sections** returns to the detected sections.

### Correcting the bar grid

Bar 1 is assumed to start on the first kick, which holds for DJ-oriented tracks. If it doesn't, click **Bars** in the header, correct the tempo or nudge the downbeat, then **Re-measure**. Stems are reused, so this takes a few seconds.

## Set view

### Local recordings

Under **Local recording** on the Set view's start screen, paste the path of a set you recorded, or click the folder button to browse in the desktop app. WAV, AIFF, FLAC, MP3 and M4A work. The file is analysed where it is; Starlib doesn't copy it, so moving it breaks playback and re-analysis until you start a new analysis from the new path.

**Import CUE** in the tracklist header replaces the tracklist with the tracks of a CUE sheet, such as the one your DJ software writes next to a recording. Each track starts at its `INDEX 01` and runs until the next one starts. Imported tracks are marked confirmed, so a later Shazam scan skips them. When the tracklist already has tracks, the import dialog warns that they will be replaced.

**Skip repeated entries**, on by default, drops an entry for a track that already appeared earlier in the sheet. rekordbox lists a track again when its deck is played or cued later, even with the channel fader down. The skipped entry's time goes to the track before it. Turn it off for a set where you really played a track twice.

rekordbox writes a CUE sheet next to each recording, with its own `hh:mm:ss` timestamps and the library file of every track. Starlib reads both: a track whose file carries a SoundCloud id from Starlib is linked to that upload, so it plays and aligns without a search, and takes its artwork from it. The track's length comes from the library file, since SoundCloud reports only the 30-second snippet for preview-only uploads. Tracks without a SoundCloud id are searched on SoundCloud by title and artist, as **Link SoundCloud** does.

### Loudness

The **Loudness** panel measures the whole set to EBU R128. Click **Measure** once; a 1-hour set takes about 22 seconds, and the result is kept until the file changes.

| Reading | Meaning |
|---------|---------|
| Integrated | Loudness of the whole set in LUFS, gated so silence and quiet fades don't pull it down. |
| Range (LRA) | Loudness range in LU: how far the set's louder and quieter passages are apart. |
| Short-term max / min | Loudest and quietest 3-second stretch. The minimum ignores anything more than 20 LU below the integrated level, so intros and fades don't count. |
| Momentary max | Loudest 400 ms. |
| True peak | Highest inter-sample peak in dBTP. |

After measuring, the timeline's top chart switches from BPM to short-term loudness in LUFS, with the median track level dashed. Switch back with the **BPM / LUFS** toggle in its corner; the choice is remembered. Hover the chart for the loudness at that point.

Type a **Target** in LUFS to get the **Input gain** that brings the integrated level there, and the true peak after that gain. A true peak above 0 dBTP, shown in red, means the gain alone will clip; use a limiter. Red ticks along the top of the LUFS chart mark every second whose true peak passes -1 dBTP after the gain, which is where a limiter would act, and the panel gives their total length.

**Even out** compares each track's integrated loudness against the median track and lists those more than 1 LU off, with their time range and the gain change that levels them: negative for tracks to turn down, positive for tracks to bring up. Click a row to jump to it. It needs a tracklist, from a CUE sheet or a Shazam scan, and skips stretches under 30 seconds, such as the fade at the end of a mix.

**Transitions** compares the 30 seconds before and after each track change and lists changes where the level jumps by 2 LU or more. A jump at a mix-in is often more audible than a difference between whole tracks. Each window stays inside its own track.

**Low end** meters the set a second time below 150 Hz, where the kick and sub bass sit, and compares each track's bass against the median track. Tracks 2 LU or more off are listed as more or less bass. Bass balance is set with EQ, not input gain.

With a tracklist, each row in the **Tracklist** shows that track's integrated loudness and true peak (**TP**). The peak turns red above -1 dBTP. Hover it for the track's bass against the median.

Transitions, Low end and the per-track readings all need a tracklist.

### Compare

The **Compare** panel puts this set next to up to three other sets in Breakdown, such as an earlier master or mixes you want to match. Tick the sets in its menu. Each set gets a colour, shown in the panel's list, the table headers and the spectrum. A set that hasn't been measured shows **Measure** in the list. Each table lists this set (**This**), every measured reference, and **Diff**: this set minus the references' average, or minus the reference when there is one.

| Section | What it compares |
|---------|------------------|
| Loudness | Integrated, range, true peak, short-term max, and peak to loudness: true peak minus integrated, in dB. A lower peak to loudness means a denser, more limited master. |
| Tonal balance | Six bands: sub (20 to 60 Hz), bass (60 to 150 Hz), low mid (150 to 500 Hz), mid (500 Hz to 2 kHz), high mid (2 to 6 kHz) and air (6 to 20 kHz). Each is that band's share of the set's power, so a set mastered louder reads the same if its balance matches. |
| Spectrum | The average spectrum of every set in 1/6-octave steps, on the same balance scale. Pink noise reads flat. |

The spectrum averages the whole set and skips silence. To compare a mastered file with your recording, start a Breakdown for each file.

To hear the difference, press **Listen** next to a set in the list. Each picked set plays silently in step with this set, so switching is instant and keeps the position; play, pause and seeking follow the timeline. **Level-match**, on by default, turns louder sets down to the quietest set's integrated loudness, so you compare sound rather than volume; the row shows how far each is turned down. A set that isn't measured can't be matched and says so. Nothing extra loads until you first press **Listen**.

### EQ preview

The **EQ preview** panel puts a bell EQ on the set while it plays, so you can try a master change before rendering it. Set **Frequency**, **Gain** (±6 dB) and **Q**, and switch it **On** and **Off** to compare. The settings are remembered.

While it's on, **Compare** shows this set's tonal balance and spectrum as the EQ would leave them, with the spectrum without the EQ drawn faintly. The loudness rows still show the set without the EQ.

The panel spells out the settings for Ableton's EQ Eight: a Bell band at the same frequency and gain. EQs define Q differently, so match the width by ear. After rendering the new master, measure it to confirm.

## Setup

Stem separation uses [Demucs](https://github.com/facebookresearch/demucs) with the `htdemucs` model, and [DrumSep](https://github.com/inagoy/drumsep) to split the drums. It needs PyTorch, which is too large to bundle, so the app sets it up on first use: click **Set up stem separation** in the Track view or under **Settings > Breakdown**. It downloads about 1 GB once (Python, PyTorch, Demucs and both models) and takes about a minute. No Python or Homebrew install is needed. **Remove** in the same place frees the space again.

Stems are FLAC, about 110 MB per six-minute track plus the drum parts. **Stems folder** in Settings > Breakdown moves them out of the app cache.

Track view works on files inside your music root folder. SoundCloud tracks aren't supported.
