"""Score the SoundCloud beatgrid/phrase detector against a Rekordbox USB export.

Runs the production detector (``analyser-stream grid``) on every analysed
track of a mounted export and compares it with Rekordbox's own beatgrid and
phrases. The tempo seed is Rekordbox's BPM rounded to a whole number, like
SoundCloud's listing, optionally shifted by ``--hint-offset`` to mimic a
listing that is off.

Usage:
    uv run python scripts/eval_beatgrid.py /Volumes/USB [--limit 50] [--hint-offset 1]

Metrics per track: tempo error, beat offset (signed median, so a constant
bias shows; split by file format, since MP3 encoder delay shifts Rekordbox's
grid on some files), downbeat agreement, phrase-boundary recall/precision
within half a bar, and phrase-label agreement by time (high-mood tracks only,
the vocabulary the detector uses).
"""

from __future__ import annotations

import argparse
import asyncio
import bisect
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.infra.breakdown import grid as grid_infra
from backend.services.rekordbox.usb import UsbExportSource

HIGH_MOOD_KINDS = {"intro", "up", "down", "chorus", "outro"}


def nearest(sorted_times: list[float], t: float) -> int:
    """Index of the value in ``sorted_times`` closest to ``t``."""
    i = bisect.bisect_left(sorted_times, t)
    if i == 0:
        return 0
    if i == len(sorted_times):
        return i - 1
    return i if sorted_times[i] - t < t - sorted_times[i - 1] else i - 1


def boundary_scores(truth: list[float], found: list[float], tol: float) -> tuple[float, float]:
    """Recall and precision of ``found`` boundaries against ``truth``."""
    if not truth or not found:
        return 0.0, 0.0
    recall = sum(any(abs(t - f) <= tol for f in found) for t in truth) / len(truth)
    precision = sum(any(abs(t - f) <= tol for t in truth) for f in found) / len(found)
    return recall, precision


def label_agreement(truth: list[tuple[str, float, float]], found: list[tuple[str, float, float]]) -> float:
    """Share of the truth's covered time where the detected kind matches."""
    total = agree = 0.0
    for kind, start, end in truth:
        total += end - start
        for f_kind, f_start, f_end in found:
            overlap = min(end, f_end) - max(start, f_start)
            if overlap > 0 and f_kind == kind:
                agree += overlap
    return agree / total if total else 0.0


async def score_track(source: UsbExportSource, track, hint_offset: float) -> dict | None:
    audio = source.get_track_audio_path(track.id)
    truth = source.get_track_analysis(track.id)
    if audio is None or len(truth.beatgrid) < 64:
        return None
    tempos = [b.bpm for b in truth.beatgrid]
    if max(tempos) - min(tempos) > 0.05:
        return None  # variable-tempo grid; the detector assumes a constant one
    true_bpm = statistics.median(tempos)
    hint = round(true_bpm) + hint_offset
    found = await grid_infra.detect_grid(audio, hint)
    if found is None:
        return {"title": track.title, "format": audio.suffix.lower(), "failed": True}

    ours = [b["time_s"] for b in found["beats"]]
    errors = [ours[nearest(ours, b.time_ms / 1000)] - b.time_ms / 1000 for b in truth.beatgrid]
    downbeats = [b.time_ms / 1000 for b in truth.beatgrid if b.beat == 1]
    downbeat_hits = sum(found["beats"][nearest(ours, t)]["beat"] == 1 for t in downbeats)
    result = {
        "title": track.title,
        "format": audio.suffix.lower(),
        "true_bpm": round(true_bpm, 3),
        "hint": hint,
        "bpm_error": round(found["bpm"] - true_bpm, 4),
        "confidence": found["confidence"],
        "offset_ms_median": round(statistics.median(errors) * 1000, 1),
        "abs_ms_median": round(statistics.median(abs(e) for e in errors) * 1000, 1),
        "within_10ms": round(sum(abs(e) <= 0.010 for e in errors) / len(errors), 3),
        "downbeat_ok": downbeat_hits / max(1, len(downbeats)),
    }
    if truth.sections:
        bar_s = 4 * 60 / true_bpm
        truth_bounds = [s.start_ms / 1000 for s in truth.sections[1:]]
        found_bounds = [p["start_s"] for p in found["phrases"][1:]]
        recall, precision = boundary_scores(truth_bounds, found_bounds, bar_s / 2)
        result["phrase_recall"] = round(recall, 3)
        result["phrase_precision"] = round(precision, 3)
        if {s.kind for s in truth.sections} <= HIGH_MOOD_KINDS:
            result["label_agreement"] = round(
                label_agreement(
                    [(s.kind, s.start_ms / 1000, s.end_ms / 1000) for s in truth.sections],
                    [(p["kind"], p["start_s"], p["end_s"]) for p in found["phrases"]],
                ),
                3,
            )
    return result


def summarise(rows: list[dict]) -> None:
    """Print medians per metric, overall and per file format."""
    scored = [r for r in rows if not r.get("failed")]
    print(f"\n{len(scored)} tracks scored, {len(rows) - len(scored)} failed")
    metrics = [
        "bpm_error",
        "confidence",
        "offset_ms_median",
        "abs_ms_median",
        "within_10ms",
        "downbeat_ok",
        "phrase_recall",
        "phrase_precision",
        "label_agreement",
    ]
    for fmt in ["all", *sorted({r["format"] for r in scored})]:
        group = [r for r in scored if fmt in ("all", r["format"])]
        print(f"\n[{fmt}] n={len(group)}")
        for m in metrics:
            values = [r[m] for r in group if m in r]
            if values:
                print(f"  {m:18} median {statistics.median(values):8.3f}   mean {statistics.mean(values):8.3f}")
    worst = sorted(scored, key=lambda r: r["within_10ms"])[:5]
    print("\nworst grids:")
    for r in worst:
        print(f"  {r['within_10ms']:.2f} on-grid  {r['offset_ms_median']:+.1f} ms  {r['title']}")


async def main() -> None:
    """Score every analysed track on the device and print a summary."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("device", type=Path, help="mount point of the Rekordbox USB export")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--hint-offset", type=float, default=0.0, help="BPM added to the rounded tempo seed")
    parser.add_argument("--out", type=Path, default=None, help="write per-track rows as JSON")
    args = parser.parse_args()

    source = UsbExportSource(args.device)
    rows: list[dict] = []
    for track in source.list_all_tracks(limit=args.limit):
        row = await score_track(source, track, args.hint_offset)
        if row is None:
            continue
        rows.append(row)
        print(json.dumps(row))
    summarise(rows)
    if args.out:
        args.out.write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
