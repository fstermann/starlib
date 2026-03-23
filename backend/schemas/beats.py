"""
Pydantic schemas for beat analysis operations.
"""

from pydantic import BaseModel


class BeatAnalysisRequest(BaseModel):
    """Request to analyse beats for an audio file."""

    file_path: str


class BeatAnalysisResponse(BaseModel):
    """Beat analysis result for a single audio file."""

    bpm: float
    beats: list[float]
    downbeats: list[float]
