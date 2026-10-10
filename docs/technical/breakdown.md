# Track Breakdown pipeline

Track Breakdown measures one local track and interprets the measurements as sections. The two stay separate: measuring is deterministic Rust, interpretation is a pure Python module that can be swapped or extended (for example, by sending a section's features to an LLM for a written breakdown).

## Flow

```
POST /api/breakdown/tracks/jobs {path}
  services/breakdown/track.py      background job, SSE progress, cancel
    ffmpeg -f hash                 SHA-256 of the decoded audio → cache key
    infra/breakdown/stems.py       demucs htdemucs (managed venv, MPS on Apple Silicon)
                                   then DrumSep on drums.flac → kick, snare, hats
    infra/breakdown/track.py       analyser-stream breakdown → features.json
    domain/arrangement.py          per-bar levels → labelled sections
```

Cache layout, under the `breakdown_cache_dir` setting or `<cache_dir>/breakdown/tracks`:

```
<audio sha256>/
  stems/{drums,bass,other,vocals}.flac
  stems/{kick,snare,hats}.flac
  features.json
```

User edits live in the `breakdown_track_edits` table, keyed by the same hash: edited sections (JSON) and an edited bar grid (`bpm`, `downbeat_s`). A grid edit makes the next job re-measure on that grid, reusing the stems.

Every finished job upserts the track into `breakdown_track_history` (path, tempo, root, bars, length, `opened_at`), which `GET /api/breakdown/tracks` lists newest first with a `missing` flag for moved files. `DELETE /api/breakdown/tracks/{digest}` removes the cache folder, the edits and the history row.

## Demucs install (`infra/breakdown/demucs_env.py`)

`POST /api/breakdown/stem-separation/install` sets up everything under `<cache_dir>/demucs`, skipping finished steps:

1. `uv`: a system install (PATH, Homebrew, `~/.local/bin`) or the standalone build from GitHub releases.
2. Python 3.12, uv-managed (`UV_PYTHON_PREFERENCE=only-managed`), so no system Python is needed.
3. `demucs` and `soundfile` into a venv, with `UV_NO_CACHE` so packages aren't stored twice.
4. The `htdemucs` weights, prefetched from Hugging Face into `demucs/hf` (`HF_HOME`).
5. The DrumSep weights (`49469ca8.th`, 167 MB) from a Hugging Face mirror into `demucs/drumsep`, checked against a pinned SHA-256.

A `.ready` marker records completion; an install counts as ready only when the DrumSep file is there too, so older installs fetch just that file. Measured on an M4: 39 s, 776 MiB (uv 28, Python 71, packages 646, model 87 MB on disk). `GET` reports `missing`, `installing` (with the step), `ready` (with size) or `error`; `DELETE` removes the folder. `STARLIB_DEMUCS_PYTHON` overrides the managed install for development.

## Drum parts

[DrumSep](https://github.com/inagoy/drumsep) is an HDemucs model trained on drum stems with four sources: `bombo` (kick), `redoblante` (snare), `platillos` (cymbals) and `toms`. It runs through the same demucs install (`demucs --repo demucs/drumsep -n 49469ca8`) on `drums.flac` after separation, about 30 s per track on an M4. A track measured before drum parts existed gets them on its next open.

Electronic kicks land mostly in `toms`: on Nightmare, `toms` correlated 0.77 with an MDX kick stem, `bombo` 0.59. So `kick.flac` is `bombo` + `toms` (ffmpeg `amix`, `normalize=0`), `snare.flac` is `redoblante` and `hats.flac` is `platillos`. The four sources sum back to the drums stem with a −25 dB residual.

Rejected: MDX23C six-stem drum models (158 s per track, 438 MB, no weight licence) and LarsNet (CC BY-NC, trained on acoustic kits).

Homebrew has no `demucs` formula, and pip-installing into Homebrew's Python is blocked (PEP 668), so it can't replace this.

## Measurement (`starlib_audio::breakdown`)

`analyser-stream breakdown --input <mix> --out features.json [--stem NAME=PATH]... [--bpm B --downbeat-s S]`

1. **Decode** to 44.1 kHz stereo.
2. **Grid.** A rough tempo from the existing spectral-flux estimator, refined by low-passing the mix at 120 Hz, differencing its rectified envelope (hop 64) and scanning ±1.5 BPM in 0.01 steps for the highest onset phase concentration. A result within 0.03 BPM of a 0.5 step snaps to it. Bar 1 starts at the first block within 20 dB of the loudest low-passed block, backtracked to where the attack crosses −40 dB. 4/4 is assumed.
3. **Per-bar features** for the mix and each stem: STFT (n_fft 4096, hop 512, Hann) power and six band powers (20–60, 60–150, 150–500, 500–2000, 2000–6000, 6000–20000 Hz) in dB relative to the loudest mix bar, magnitude-weighted centroid, side/mid power ratio, and mean positive log-magnitude flux.
4. **Groove grid.** Per 16th note, the in-band energy of the unwindowed slot (equal to band-passed energy by Parseval), in dB relative to the lane's loudest slot: kick (drums 30–120 Hz), drum mids (drums 300–3000 Hz), drum tops (drums 3 kHz+), bass (bass 30–300 Hz).
5. **Tonal.** The three strongest peaks of the averaged bass-stem spectrum between 30 and 200 Hz (n_fft 16384, parabolic interpolation), and per-bar chroma of the `other` stem from an 8192-point STFT between 55 Hz and 2 kHz. No major/minor key is claimed; key profiles were unreliable on techno.

Bump `PIPELINE_VERSION` in `starlib_audio/src/breakdown/mod.rs` and `backend/services/breakdown/track.py` together whenever a measured value changes; cached features with another version are recomputed.

## `features.json`

| Field | Shape |
|-------|-------|
| `pipeline_version`, `sample_rate`, `duration_s` | scalars |
| `grid` | `bpm`, `bpm_rough`, `concentration` (`null` for a hand-set grid), `downbeat_s`, `bar_s`, `n_bars`, `beats_per_bar` |
| `bands_hz` | six `[low, high]` pairs |
| `sources.<mix\|drums\|bass\|other\|vocals>` | per-bar arrays: `db`, `bands_db` (6 each), `centroid_hz`, `width`, `onset` |
| `groove.<kick\|drum_mids\|drum_tops\|bass>` | per bar, 16 dB values |
| `tonal` | `root`, `bass_peaks` (`hz`, `note`, `db`), `chroma` (per bar, 12 values C..B, max 1) |

Arrays are indexed by bar − 1. Bars after the music ends (reverb tail) are kept; sectioning labels them `tail`.

## Sections (`backend/domain/arrangement.py`)

The stems carry the arrangement. Each bar becomes a vector of kick (drums stem below 60 Hz), drums, bass and other levels, mix highs and width, with levels clipped at −40 dB. A 5-bar median filter removes one- and two-bar fills. Every bar is scored by the distance between the mean vectors of the four bars before and after it; peaks above 8 at least four bars apart become boundaries, moved onto the nearest 4-bar line when that line scores within 80% of the peak. A section inside the track shorter than 8 bars joins its more similar neighbour.

Labels come from which stems play in most of a section's bars: `filtered` (bass, highs 6 dB under the groove median), `groove` / `main` (kick and bass, before / after the first section without them), `intro` / `outro` (kick or drums before the first / after the last bass), `build` (kick or drums without bass, leading into a full section or another build), `break` (kick without bass, at most 8 bars between two full sections), `breakdown` (no kick and no bass) and a quiet final `tail`. Neighbours with the same label merge.

Limits: the thresholds were tuned on three techno tracks, with Entasia – Bumper (144 BPM, root B, 224 bars, nine sections) as the checked reference. `tests/services/breakdown/test_track_reference.py` checks it when `STARLIB_BREAKDOWN_REFERENCE` points at the file.

## Playback

`frontend/src/lib/stem-player.ts` decodes each lane to an `AudioBuffer` and starts every lane on the same `AudioContext` time and offset, which keeps them sample-locked; loops use `AudioBufferSourceNode.loopStart/loopEnd`. The original decodes only once it is unmuted or soloed, since each decoded lane costs about 150 MB for a six-minute track. The drums stem itself isn't played: its lane is the kick, snare and hats lanes summed through a shared drums gain, so the Drums lane's mute, solo and volume apply to all three, and soloing a part keeps the drums lane audible. Waveforms are built from the decoded buffers (min/max and sum of squares per 64-sample block): all played lanes summed for the Original lane, the three parts summed for Drums, and each other lane on its own. The spectrum panel reads an `AnalyserNode` (8192-point FFT) on the master bus.
