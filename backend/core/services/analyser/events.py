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


class TrackIdentifiedEvent(BaseModel):
    type: Literal["track.identified"] = "track.identified"
    job_id: str
    section_index: int
    title: str | None
    artist: str | None
    shazam_id: str | None
    confidence: float
    pitch_offset: float


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


AnalyserEvent = (
    MetaEvent
    | WindowBpmEvent
    | SectionDetectedEvent
    | TrackIdentifiedEvent
    | JobCompleteEvent
    | JobErrorEvent
    | ReanalyseStartedEvent
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
