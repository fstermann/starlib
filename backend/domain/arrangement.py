"""Section boundaries and first-guess labels for a track's arrangement.

Interprets per-bar measurements (from ``analyser-stream breakdown``) as
sections. The stems carry the arrangement: a boundary goes where the kick,
drums, bass, other stem, highs or width change most between the four bars
before and after it, once one- and two-bar fills are smoothed out.
Labels come from which stems play. They are a starting point for the user to
edit, not ground truth.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from statistics import mean, median

# Every bar is scored by how much WINDOW_BARS on either side differ; peaks at
# least MIN_CHANGE_BARS apart become boundaries. A peak one bar off a
# LINE_BARS line moves onto it when the line scores at least LINE_PREFERENCE
# of the peak, since phrases usually change on the line.
WINDOW_BARS = 4
MIN_CHANGE_BARS = 4
LINE_BARS = 4
LINE_PREFERENCE = 0.8
# Odd window of the median filter; removes fills of up to two bars.
FILL_FILTER_BARS = 5
# Levels are dB relative to the loudest mix bar; quieter values are clipped so
# a silent stem doesn't dominate the distance.
LEVEL_FLOOR_DB = -40.0
# Width is a power ratio; this scales it to roughly the dB levels' range.
WIDTH_WEIGHT = 20.0
BOUNDARY_DISTANCE = 8.0
KICK_PRESENT_DB = -25.0
DRUMS_PRESENT_DB = -30.0
BASS_PRESENT_DB = -30.0
FILTERED_HIGHS_DB = 6.0
TAIL_DB = 15.0
# A section has a stem when at least this share of its bars do.
PRESENT_SHARE = 0.5
# A labelled section inside the track shorter than this joins its most similar
# neighbour; the first and last may be shorter (a cold start, a tail).
MIN_SECTION_BARS = 8
# A bass-less stretch between two grooves up to this long is a break, not a build.
MAX_BREAK_BARS = 8


@dataclass(frozen=True)
class BarLevels:
    """Measurements of one bar used for sectioning.

    Attributes:
        kick_db: Drum stem energy below 60 Hz.
        drums_db: Drum stem level.
        bass_db: Bass stem level.
        other_db: Other stem level (synths, pads, leads).
        mix_db: Full-mix level.
        high_db: Full-mix energy above 6 kHz.
        width: Full-mix side power over mid power.
    """

    kick_db: float
    drums_db: float
    bass_db: float
    other_db: float
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
    length: int
    kick: bool
    drums: bool
    bass: bool
    mix_db: float
    high_db: float


def detect_sections(bars: list[BarLevels]) -> list[Section]:
    """Split bars into labelled sections.

    Args:
        bars: Per-bar levels in track order; bar 1 is the first element.

    Returns:
        Sections covering every bar, in order; neighbours never share a label.
    """
    if not bars:
        return []
    starts = [0, *_boundaries(bars)]
    while True:
        runs = [bars[a:b] for a, b in zip(starts, [*starts[1:], len(bars)], strict=True)]
        labels = _label([_profile(run) for run in runs], bars)
        sections = _merge_labels(starts, runs, labels)
        short = next(
            (i for i, sec in enumerate(sections[1:-1], 1) if sec.end_bar - sec.start_bar + 1 < MIN_SECTION_BARS),
            None,
        )
        if short is None:
            return sections
        starts = _absorb(starts, sections, short, bars)


def _merge_labels(starts: list[int], runs: list[list[BarLevels]], labels: list[str]) -> list[Section]:
    sections: list[Section] = []
    for start, run, label in zip(starts, runs, labels, strict=True):
        end = start + len(run)
        if sections and sections[-1].label == label:
            sections[-1] = Section(sections[-1].start_bar, end, label)
        else:
            sections.append(Section(start + 1, end, label))
    return sections


def _absorb(starts: list[int], sections: list[Section], index: int, bars: list[BarLevels]) -> list[int]:
    """Drop the boundary between ``sections[index]`` and its more similar neighbour."""

    def centre(sec: Section) -> list[float]:
        return [mean(v) for v in zip(*map(_vector, bars[sec.start_bar - 1 : sec.end_bar]), strict=True)]

    def distance(a: Section, b: Section) -> float:
        return sum((x - y) ** 2 for x, y in zip(centre(a), centre(b), strict=True)) ** 0.5

    short = sections[index]
    before, after = sections[index - 1], sections[index + 1]
    dropped = short.start_bar - 1 if distance(short, before) <= distance(short, after) else short.end_bar
    return [s for s in starts if s != dropped]


def _vector(bar: BarLevels) -> tuple[float, ...]:
    levels = (bar.kick_db, bar.drums_db, bar.bass_db, bar.other_db, bar.high_db)
    return (*(max(db, LEVEL_FLOOR_DB) for db in levels), min(bar.width, 1.0) * WIDTH_WEIGHT)


def _smoothed(bars: list[BarLevels]) -> list[tuple[float, ...]]:
    half = FILL_FILTER_BARS // 2
    columns = list(zip(*map(_vector, bars), strict=True))
    filtered = [[median(col[max(0, i - half) : i + half + 1]) for i in range(len(col))] for col in columns]
    return list(zip(*filtered, strict=True))


def _change(vectors: Sequence[tuple[float, ...]], at: int, window: int) -> float:
    """Distance between the mean vectors of ``window`` bars before and from ``at``."""
    before, after = vectors[max(0, at - window) : at], vectors[at : at + window]
    if not before or not after:
        return 0.0
    mean_before = [mean(v) for v in zip(*before, strict=True)]
    mean_after = [mean(v) for v in zip(*after, strict=True)]
    return sum((x - y) ** 2 for x, y in zip(mean_before, mean_after, strict=True)) ** 0.5


def _boundaries(bars: list[BarLevels]) -> list[int]:
    """0-based indices of the first bar of every section after the first."""
    vectors = _smoothed(bars)
    scores = [_change(vectors, at, WINDOW_BARS) for at in range(len(bars))]
    picked: list[int] = []
    for at in sorted(range(1, len(bars)), key=lambda b: -scores[b]):
        if scores[at] <= BOUNDARY_DISTANCE:
            break
        if all(abs(at - other) >= MIN_CHANGE_BARS for other in picked):
            picked.append(at)
    return sorted(_on_line(at, scores) for at in picked)


def _on_line(at: int, scores: list[float]) -> int:
    """Move a boundary onto the nearest 4-bar line when the change there is nearly as sharp."""
    line = round(at / LINE_BARS) * LINE_BARS
    if line != at and abs(line - at) <= 1 and 0 < line < len(scores) and scores[line] >= LINE_PREFERENCE * scores[at]:
        return line
    return at


def _share(run: list[BarLevels], present: int) -> bool:
    """Whether ``present`` of the run's bars is at least :data:`PRESENT_SHARE` of them."""
    return present >= PRESENT_SHARE * len(run)


def _profile(run: list[BarLevels]) -> _Profile:
    return _Profile(
        length=len(run),
        kick=_share(run, sum(b.kick_db > KICK_PRESENT_DB for b in run)),
        drums=_share(run, sum(b.drums_db > DRUMS_PRESENT_DB for b in run)),
        bass=_share(run, sum(b.bass_db > BASS_PRESENT_DB for b in run)),
        mix_db=mean(b.mix_db for b in run),
        high_db=mean(b.high_db for b in run),
    )


def _label(profiles: list[_Profile], bars: list[BarLevels]) -> list[str]:
    loudest = max(b.mix_db for b in bars)
    grooves = [b for b in bars if b.kick_db > KICK_PRESENT_DB and b.bass_db > BASS_PRESENT_DB]
    groove_highs = median(b.high_db for b in grooves) if grooves else max(b.high_db for b in bars)
    with_bass = [i for i, p in enumerate(profiles) if p.bass]
    first_bass = with_bass[0] if with_bass else len(profiles)
    last_bass = with_bass[-1] if with_bass else -1

    labels = [""] * len(profiles)
    # Right to left, so a build can run into another build before the drop.
    for i in reversed(range(len(profiles))):
        p = profiles[i]
        next_full = i + 1 < len(profiles) and profiles[i + 1].kick and profiles[i + 1].bass
        leads_to_drop = next_full or (i + 1 < len(profiles) and labels[i + 1] == "build")
        if i == len(profiles) - 1 and p.mix_db < loudest - TAIL_DB:
            labels[i] = "tail"
        elif p.bass and p.high_db < groove_highs - FILTERED_HIGHS_DB:
            labels[i] = "filtered"
        elif p.kick and p.bass:
            labels[i] = "full"
        elif i < first_bass and p.kick:
            labels[i] = "intro"
        elif i > last_bass and (p.kick or p.drums):
            labels[i] = "outro"
        elif (p.kick or p.drums) and leads_to_drop:
            labels[i] = "build"
        elif not p.kick:
            labels[i] = "breakdown"
        else:
            labels[i] = "break"

    _short_gaps_are_breaks(labels, profiles)
    first_break = next((i for i in range(first_bass, len(labels)) if labels[i] != "full"), len(labels))
    return [("groove" if i < first_break else "main") if label == "full" else label for i, label in enumerate(labels)]


def _short_gaps_are_breaks(labels: list[str], profiles: list[_Profile]) -> None:
    """Relabel a short run of builds with a kick between two full sections as a break."""
    i = 0
    while i < len(labels):
        j = i
        while j < len(labels) and labels[j] == "build":
            j += 1
        gap = profiles[i:j]
        if (
            gap
            and 0 < i
            and j < len(labels)
            and labels[i - 1] == labels[j] == "full"
            and sum(p.length for p in gap) <= MAX_BREAK_BARS
            and all(p.kick for p in gap)
        ):
            labels[i:j] = ["break"] * (j - i)
        i = max(j, i + 1)


MAX_LABEL_LENGTH = 40


def validate_sections(sections: list[Section], n_bars: int) -> None:
    """Check that ``sections`` cover bars 1 to ``n_bars`` in order without gaps.

    Args:
        sections: Sections to check.
        n_bars: Number of bars in the track.

    Raises:
        ValueError: The sections leave a gap, overlap, run past the track or
            carry an empty or overlong label.
    """
    expected_start = 1
    for s in sections:
        if s.start_bar != expected_start:
            raise ValueError(f"section starting at bar {s.start_bar} should start at bar {expected_start}")
        if s.end_bar < s.start_bar:
            raise ValueError(f"section {s.start_bar}-{s.end_bar} ends before it starts")
        if not s.label.strip() or len(s.label) > MAX_LABEL_LENGTH:
            raise ValueError(f"section {s.start_bar}-{s.end_bar} needs a label of 1 to {MAX_LABEL_LENGTH} characters")
        expected_start = s.end_bar + 1
    if expected_start != n_bars + 1:
        raise ValueError(f"sections end at bar {expected_start - 1}, the track has {n_bars} bars")
