"""Analyse one local track and print its grid, root note and sections.

Usage:
  STARLIB_DEMUCS_PYTHON=/path/to/demucs-env/bin/python \\
    uv run python scripts/breakdown_track.py <audio file>

Stems and features are cached under ``<cache_dir>/breakdown/tracks/``, so a
second run on the same audio only re-runs the sectioning.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

from backend.services.breakdown.track import analyse_track


def main() -> None:
    """Parse arguments, analyse the track and print a summary."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()

    started = time.monotonic()

    def on_stage(stage: str) -> None:
        print(f"[{time.monotonic() - started:6.1f}s] {stage}", file=sys.stderr)

    result = asyncio.run(analyse_track(args.path, on_stage))
    grid = result.features["grid"]
    tonal = result.features["tonal"]
    peaks = ", ".join(f"{p['note']} {p['hz']:.1f} Hz" for p in tonal["bass_peaks"])
    print(f"{args.path.name}  ({result.digest[:12]})")
    print(f"tempo  {grid['bpm']:g} BPM, bar 1 at {grid['downbeat_s']:.3f} s, {grid['n_bars']} bars")
    print(f"root   {tonal['root']}  (bass peaks: {peaks})")
    print()
    for s in result.sections:
        start_s = grid["downbeat_s"] + (s.start_bar - 1) * grid["bar_s"]
        end_s = grid["downbeat_s"] + s.end_bar * grid["bar_s"]
        print(f"{s.start_bar:4d}-{s.end_bar:<4d} {_clock(start_s)}-{_clock(end_s)}  {s.label}")


def _clock(seconds: float) -> str:
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


if __name__ == "__main__":
    main()
