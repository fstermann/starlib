"""Analyser event types — the wire format the SSE endpoint relays."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class MetaEvent(BaseModel):
    type: Literal["meta"] = "meta"
    job_id: str
    duration_s: float
    sample_rate: int
    title: str | None = None
    artist: str | None = None


class WindowBpmEvent(BaseModel):
    type: Literal["window.bpm"] = "window.bpm"
    job_id: str
    start_s: float
    end_s: float
    bpm: float
    confidence: str  # "high" | "medium" | "low"


class SectionDetectedEvent(BaseModel):
    type: Literal["section.detected"] = "section.detected"
    job_id: str
    section_index: int
    start_s: float
    end_s: float
    confidence: float


class ShazamScanEvent(BaseModel):
    """A single point on the Shazam scan grid — one (scan_s, pitch_offset).

    Surfaces every attempt, including misses (``title=None``), so the UI
    can reflect scan progress in real time. ``track.timeline`` events
    carry the post-aggregation view used for the actual tracklist.
    """

    type: Literal["shazam.scan"] = "shazam.scan"
    job_id: str
    scan_s: float
    title: str | None
    artist: str | None
    shazam_id: str | None
    confidence: float
    pitch_offset: float
    # Tier this scan was produced under: "sweep" | "refine" | "pinpoint".
    tier: str = "sweep"
    # Audio preview URL (~30s m4a, served from shazamcdn.com) and
    # cover-art URL extracted from the same Shazam response. ``None``
    # for misses and for matches that don't include either field.
    preview_url: str | None = None
    artwork_url: str | None = None


class TrackTimelineEvent(BaseModel):
    """Aggregated run of consecutive matching scan points → one track.

    Manual user-added entries reuse this event with ``source="manual"``
    and an ``override_id`` so the frontend can issue a delete.
    """

    type: Literal["track.timeline"] = "track.timeline"
    job_id: str
    start_s: float
    end_s: float
    title: str
    artist: str | None
    shazam_id: str | None
    confidence: float
    source: Literal["shazam", "manual"] = "shazam"
    override_id: int | None = None
    soundcloud_id: int | None = None
    soundcloud_permalink_url: str | None = None
    artwork_url: str | None = None
    # Original track length (seconds) — present for manual entries that
    # carry a SoundCloud-sourced duration; ``None`` for Shazam runs.
    duration_s: float | None = None
    # Mix tempo at the matched scan point and the semitone offset that
    # produced the match. ``original_bpm = set_bpm × 2^(pitch_offset/12)``
    # and ``effective_duration_in_set = duration_s × 2^(pitch_offset/12)``.
    set_bpm: float | None = None
    pitch_offset: float | None = None
    # User-curation flags. Carried on every track.timeline event so SSE
    # replays after a snapshot refresh don't silently revert a confirm
    # the user just toggled (the event is the authoritative payload for
    # the row, so omitting these would clobber them).
    confirmed: bool = False
    user_edited: bool = False


class JobCompleteEvent(BaseModel):
    type: Literal["job.complete"] = "job.complete"
    job_id: str


class JobErrorEvent(BaseModel):
    type: Literal["job.error"] = "job.error"
    job_id: str
    message: str


class ReanalyseStartedEvent(BaseModel):
    type: Literal["job.reanalyse_started"] = "job.reanalyse_started"
    job_id: str
    ranges: list[dict[str, float]] = Field(default_factory=list)


class ShazamScanStartedEvent(BaseModel):
    """Marks the start of a Shazam scan pass — lets the frontend reset
    its per-run progress so a refine over a refresh range doesn't read as
    "stuck at 99%" because the last sweep scan still sits in state."""

    type: Literal["shazam.scan_started"] = "shazam.scan_started"
    job_id: str
    tier: str
    region: tuple[float, float] | None = None
    # Count of scan points the scheduler will walk after subtracting
    # confirmed-track ranges. ``0`` means everything was excluded.
    total_points: int


AnalyserEvent = (
    MetaEvent
    | WindowBpmEvent
    | SectionDetectedEvent
    | ShazamScanEvent
    | TrackTimelineEvent
    | JobCompleteEvent
    | JobErrorEvent
    | ReanalyseStartedEvent
    | ShazamScanStartedEvent
)


def event_to_sse(event: AnalyserEvent) -> str:
    """Serialise an event as a single SSE message (with trailing blank line)."""
    payload = event.model_dump_json()
    return f"event: {event.type}\ndata: {payload}\n\n"


def event_from_subprocess_line(job_id: str, line: dict[str, Any]) -> AnalyserEvent | None:
    """Map a JSON-line emitted by ``analyser-stream`` to an :class:`AnalyserEvent`.

    Returns ``None`` for unrecognised event types so the consumer can skip
    forward without raising. Subprocess errors are translated to
    :class:`JobErrorEvent` here so the controller treats them uniformly.
    """
    kind = line.get("type")
    if kind == "meta":
        return MetaEvent(
            job_id=job_id,
            duration_s=float(line.get("duration_s", 0.0)),
            sample_rate=int(line.get("sample_rate", 0)),
        )
    if kind == "window.bpm":
        return WindowBpmEvent(
            job_id=job_id,
            start_s=float(line["start_s"]),
            end_s=float(line["end_s"]),
            bpm=float(line["bpm"]),
            confidence=str(line.get("confidence", "low")),
        )
    if kind == "section.detected":
        return SectionDetectedEvent(
            job_id=job_id,
            section_index=int(line.get("index", 0)),
            start_s=float(line["start_s"]),
            end_s=float(line["end_s"]),
            confidence=float(line.get("confidence", 0.0)),
        )
    if kind == "job.complete":
        return JobCompleteEvent(job_id=job_id)
    if kind == "error":
        return JobErrorEvent(job_id=job_id, message=str(line.get("message", "unknown error")))
    return None
