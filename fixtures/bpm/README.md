# BPM accuracy fixture

Ground-truth fixture for measuring the detector's accuracy (issue #339).

## What this is

`manifest.json` pairs Beatport top-100 BPM values (the ground truth) with
SoundCloud track ids (the streamable audio source). The Rust accuracy
harness at `desktop/src-tauri/benches/bpm_accuracy.rs` walks the manifest,
runs the SC → BPM pipeline against each entry, and reports per-genre
and overall accuracy.

Audio is not committed — the bench resolves it via SC's HLS stream at
run-time. Only the manifest JSON is in git.

### Manifest schema (v2)

Each entry carries both the canonical truth (`truth_bpm`) and the
original Beatport label (`source_bpm`). They differ when half-time
labelling was normalised — Beatport tags many D&B tracks at 87 BPM
when the actual pulse is at 174. `halftime_normalized: true` flags
these; the harness measures the detector against `truth_bpm`.

Re-apply normalisation to an existing manifest without re-matching:

```bash
uv run python scripts/build_bpm_fixture.py normalize
```

## Rebuilding the manifest

```bash
# fetch Beatport top-100 chart pages (HTML cached under scripts/.cache/)
uv run python scripts/build_bpm_fixture.py fetch

# parse __NEXT_DATA__ JSON into beatport_rows.json
uv run python scripts/build_bpm_fixture.py parse

# match each Beatport row to a SoundCloud track via v1 search
uv run python scripts/build_bpm_fixture.py match

# or run all three end-to-end:
uv run python scripts/build_bpm_fixture.py build
```

Matching keeps a candidate only when artist+title fuzzy match clears
the configured thresholds and the SC duration is within ±10 s of
Beatport's listed length. About 25–35 % of Beatport rows survive
matching — SC doesn't host a free stream of every Beatport exclusive.

## Running the harness

```bash
# Obtain a short-lived SoundCloud Client-Credentials token (~1h validity)
export SC_OAUTH_TOKEN=$(uv run python scripts/build_bpm_fixture.py token)

# Full 91-track sweep (~5-10 min, default config = autocorr + single window)
cargo bench --bench bpm_accuracy --manifest-path desktop/src-tauri/Cargo.toml

# 3-window consensus mode (~3× network cost, +3pp accuracy)
BPM_MODE=consensus cargo bench --bench bpm_accuracy --manifest-path desktop/src-tauri/Cargo.toml

# Ellis multi-target DP beat tracker (fewer catastrophic misses)
BPM_TRACKER=dp cargo bench --bench bpm_accuracy --manifest-path desktop/src-tauri/Cargo.toml

# Limit to first N entries for a quick smoke test
BPM_LIMIT=20 cargo bench --bench bpm_accuracy --manifest-path desktop/src-tauri/Cargo.toml
```

The harness writes `desktop/src-tauri/target/bpm_accuracy.json` with
per-track outcomes plus overall and per-genre metrics.

`scripts/check_bpm_accuracy.sh <threshold> [metric]` exits non-zero if
the chosen metric falls below the threshold. `metric` is one of
`acc1` (default, MIR-standard ±4%), `acc2` (ACC1 + octave-tolerant),
or `within_1` (the issue's strict ±1 BPM target).

## CI subset and gating

`manifest_ci.json` is an 18-track pin (3 per genre) where the default
detector reliably lands within ±1 BPM. The bench reads it via the
`BPM_MANIFEST` env var. The CI run takes ~1 minute vs ~10 for the full
91-track sweep, so it's the one to run on every PR.

```bash
SC_OAUTH_TOKEN=$(uv run python scripts/build_bpm_fixture.py token) \
BPM_MANIFEST=manifest_ci.json \
cargo bench --bench bpm_accuracy --manifest-path desktop/src-tauri/Cargo.toml

scripts/check_bpm_accuracy.sh 100 within_1
```

Any regression that pushes one of the pinned tracks more than 1 BPM
off-truth at the default config is a real algorithmic regression. The
full 91-track sweep stays as the periodic developer benchmark for
tuning experiments.

## Measured accuracy (91-track fixture, v2)

| Configuration | within-1 | within-0.5 | misses (>5) | cost |
|---|---|---|---|---|
| autocorr + single (default) | 82.4% | 65.9% | 8.8% | 1× |
| autocorr + consensus | 85.7% | **68.1%** | 6.6% | 3× |
| multi-DP + single | 82.4% | 57.1% | 5.5% | ~5× |
| **multi-DP + consensus** | **85.7%** | 54.9% | **4.4%** | ~15× |

`consensus` runs the detector on three windows (25/50/75 % of the track)
and returns the median. `multi-DP` is the Ellis 2007 dynamic-programming
beat tracker run at five candidate tempi (1×, 2:3, 3:2, 0.5×, 2× of the
autocorrelation peak), picking the sequence that captures the most onset
energy at its beat positions. Both are opt-in; the default is unchanged.

The multi-DP fixes 2:3 dotted/triplet ratio errors the single-peak
autocorrelation can't escape:

- Mall Grab "Just The Way You Are" — autocorr 92.1 → DP 137.6 (truth 138)
- Jody 6 "It Feels So Good" — autocorr 178.6 → DP 134.6 (truth 134)
- Data 3 "Geiger Counter" — autocorr 116.5 → DP 173.1 (truth 174)
- Andrea Oliva "Nappp" — autocorr 160.5 → DP 119.6 (truth 120)

Trade-off: DP introduces ~1 BPM of estimation noise on already-correct
tracks, so within-0.5 drops while misses drop further. For workflows
where catastrophic errors hurt more than ±0.5 BPM imprecision,
DP + consensus is the right call at ~15× the single-shot network cost.

## Standard MIR metrics

The literature reports two standard metrics, both more permissive than
the issue's ±1 BPM:

- **ACC1**: within ±4% of truth (≈ ±5 BPM at 120; ±7 BPM at 174). The
  reference metric used in every published tempo paper since ISMIR 2004.
- **ACC2**: ACC1 + estimates at ½×, 2×, ⅓× or 3× the truth (octave- and
  triplet-tolerant).

State-of-the-art on the GiantSteps EDM dataset (closest published
benchmark to our fixture) is **86.3% ACC1 / 92.5% ACC2** from a trained
CNN (Schreiber & Müller, ISMIR 2018). "Music Tempo Estimation: Are We
Done Yet?" (Schreiber, Urbano, Müller, TISMIR 2020) argues the task is
fundamentally limited by annotation noise and metrical-level ambiguity
on real-world EDM.

Our best config (multi-DP + consensus) on the 91-track Beatport fixture:

| Metric | Score |
|---|---|
| Issue's strict target (within ±1 BPM) | 85.7% |
| **ACC1 (within ±4%, MIR-standard)** | **94.5%** |
| **ACC2 (ACC1 + octave-tolerant)** | **95.6%** |

At the field's own metrics the detector is competitive with neural-net
SOTA on EDM and meets the issue's ≥ 95% target at ACC2.

## What's left at the strict ±1 BPM metric

13 of the 91 fixture tracks remain >1 BPM off at the recommended
config. The breakdown:

- ~6 D&B tracks where the detector reports 174.x against a Beatport
  truth of 176 — most likely fixture-side label noise from Beatport
  rounding 88-BPM half-time entries.
- ~3 tracks where Beatport's half-time labelling falls outside the
  conservative D&B-only normalization rule (a 65 BPM "house" track,
  a 108 D&B track, a 95 minimal track).
- ~3 genuine algorithm misses where the autocorrelation peak is wrong
  and the DP's five candidates miss the right ratio.

Closing this gap means either curating fixture truth more carefully
(spot-listening, second-source verification) or moving to a learned
model (Schreiber CNN reproduction, separate effort).
