"""Section boundaries and first-guess labels for a track's arrangement.

Interprets per-bar measurements (from ``analyser-stream breakdown``) as
sections: 16-bar phrases are compared, a boundary goes where their average
levels jump, and each section gets a rule-based label. Labels are a starting
point for the user to edit, not ground truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from statistics import mean, median

PHRASE_BARS = 16
# Levels are dB relative to the loudest mix bar; quieter values are clipped so
# a silent stem doesn't dominate the phrase distance.
LEVEL_FLOOR_DB = -40.0
# Width is a power ratio; this scales it to roughly the dB levels' range.
WIDTH_WEIGHT = 20.0
BOUNDARY_DISTANCE = 6.0
KICK_PRESENT_DB = -25.0
BASS_PRESENT_DB = -30.0
FILTERED_HIGHS_DB = 6.0
WIDE = 0.2
TAIL_DB = 15.0
# A section has the kick (or bass) when at least this share of its bars do.
PRESENT_SHARE = 0.5


@dataclass(frozen=True)
class BarLevels:
    """Measurements of one bar used for sectioning.

    Attributes:
        kick_db: Drum stem energy below 60 Hz.
        bass_db: Bass stem level.
        mix_db: Full-mix level.
        high_db: Full-mix energy above 6 kHz.
        width: Full-mix side power over mid power.
    """

    kick_db: float
    bass_db: float
    mix_db: float
    high_db: float
    width: float


@dataclass(frozen=True)
class Section:
    """A run of bars with one label. Bars are 1-based and inclusive.

    Attributes:
        start_bar: First bar of the section.
        end_bar: Last bar of the section.
        label: First-guess label, e.g. ``"intro"`` or ``"breakdown"``.
    """

    start_bar: int
    end_bar: int
    label: str


@dataclass(frozen=True)
class _Profile:
    kick: bool
    bass: bool
    mix_db: float
    high_db: float
    width: float


def detect_sections(bars: list[BarLevels]) -> list[Section]:
    """Split bars into labelled sections.

    Args:
        bars: Per-bar levels in track order; bar 1 is the first element.

    Returns:
        Sections covering every bar, in order.
    """
    if not bars:
        return []
    phrases = [bars[i : i + PHRASE_BARS] for i in range(0, len(bars), PHRASE_BARS)]
    runs: list[list[BarLevels]] = [phrases[0]]
    for prev, phrase in pairwise(phrases):
        if _distance(prev, phrase) > BOUNDARY_DISTANCE:
            runs.append(list(phrase))
        else:
            runs[-1].extend(phrase)

    profiles = [_profile(run) for run in runs]
    labels = _label(profiles, bars)
    sections: list[Section] = []
    start = 1
    for run, label in zip(runs, labels, strict=True):
        end = start + len(run) - 1
        if sections and sections[-1].label == label:
            sections[-1] = Section(sections[-1].start_bar, end, label)
        else:
            sections.append(Section(start, end, label))
        start = end + 1
    return sections


def _vector(bar: BarLevels) -> tuple[float, ...]:
    levels = (bar.kick_db, bar.bass_db, bar.mix_db, bar.high_db)
    return (*(max(db, LEVEL_FLOOR_DB) for db in levels), bar.width * WIDTH_WEIGHT)


def _distance(a: list[BarLevels], b: list[BarLevels]) -> float:
    mean_a = [mean(v) for v in zip(*map(_vector, a), strict=True)]
    mean_b = [mean(v) for v in zip(*map(_vector, b), strict=True)]
    return sum((x - y) ** 2 for x, y in zip(mean_a, mean_b, strict=True)) ** 0.5


def _profile(run: list[BarLevels]) -> _Profile:
    return _Profile(
        kick=sum(b.kick_db > KICK_PRESENT_DB for b in run) >= PRESENT_SHARE * len(run),
        bass=sum(b.bass_db > BASS_PRESENT_DB for b in run) >= PRESENT_SHARE * len(run),
        mix_db=mean(b.mix_db for b in run),
        high_db=mean(b.high_db for b in run),
        width=mean(b.width for b in run),
    )


def _label(profiles: list[_Profile], bars: list[BarLevels]) -> list[str]:
    loudest = max(b.mix_db for b in bars)
    grooves = [b for b in bars if b.kick_db > KICK_PRESENT_DB and b.bass_db > BASS_PRESENT_DB]
    groove_highs = median(b.high_db for b in grooves) if grooves else max(b.high_db for b in bars)
    with_bass = [i for i, p in enumerate(profiles) if p.bass]
    first_bass = with_bass[0] if with_bass else len(profiles)
    last_bass = with_bass[-1] if with_bass else -1
    first_break = next((i for i, p in enumerate(profiles) if i > first_bass and not p.bass), len(profiles))

    labels: list[str] = []
    for i, p in enumerate(profiles):
        is_full_next = i + 1 < len(profiles) and profiles[i + 1].kick and profiles[i + 1].bass
        if i == len(profiles) - 1 and p.mix_db < loudest - TAIL_DB:
            labels.append("tail")
        elif p.kick and p.bass and p.high_db < groove_highs - FILTERED_HIGHS_DB:
            labels.append("filtered")
        elif p.kick and p.bass:
            labels.append("groove" if i < first_break else "main")
        elif i < first_bass and p.kick:
            labels.append("intro")
        elif i > last_bass and p.kick:
            labels.append("outro")
        elif not p.bass and is_full_next and (p.kick or p.high_db > groove_highs - FILTERED_HIGHS_DB):
            labels.append("build")
        elif p.width > WIDE:
            labels.append("breakdown")
        else:
            labels.append("break")
    return labels
