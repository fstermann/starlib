"""Pydantic schemas for Rekordbox ANLZ waveform operations."""

from pydantic import BaseModel


class RekordboxWaveformEntry(BaseModel):
    """A single waveform column from the PWV5 colour-detail tag."""

    height: float
    """Normalised column height, 0.0 (silent) to 1.0 (maximum)."""

    r: int
    """Red channel (0–255)."""

    g: int
    """Green channel (0–255)."""

    b: int
    """Blue channel (0–255)."""


class RekordboxBeat(BaseModel):
    """A single beat from the PQTZ beat grid."""

    beat: int
    """Position within the bar (1–4)."""

    tempo: float
    """BPM at this beat."""

    time: float
    """Beat time in seconds."""


class RekordboxWaveformResponse(BaseModel):
    """Colour-detail waveform + beat grid for a single audio file."""

    entries: list[RekordboxWaveformEntry]
    """PWV5 colour-detail entries (150 per second of audio)."""

    beats: list[RekordboxBeat]
    """PQTZ beat grid."""

    found: bool
    """``True`` when ANLZ files were located and successfully parsed."""

    source: str
    """Where the data came from: ``"rekordbox_db"`` or ``"none"``."""
