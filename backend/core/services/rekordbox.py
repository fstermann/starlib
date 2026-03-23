"""Rekordbox ANLZ waveform reader.

Uses ``pyrekordbox`` to:

1. Look up the ANLZ analysis file path for a given audio track via the
   encrypted Rekordbox 6 database (``master.db``).
2. Parse the ``PWV5`` (Waveform Color Detail) tag from the ``.EXT`` file —
   150 entries/second, each a 2-byte big-endian int with 3-bit RGB +
   5-bit height packed as ``rrr ggg bbb hhhhh xx``.
3. Parse the ``PQTZ`` (Beat Grid) tag from the ``.DAT`` file — beat
   positions in milliseconds with bar position (1–4) and tempo.

ANLZ files live under ``~/Library/Pioneer/rekordbox/share/`` and have
opaque UUID-based paths.  The mapping from audio file to ANLZ path is
stored in ``djmdContent.AnalysisDataPath`` in the encrypted Rekordbox 6
database.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

# PWV5 colour detail: 3 bits per channel → 0–7.  Scale to 0–255.
_COLOR_SCALE = 255 / 7

# PWV5 entries per second of audio (one per half-frame, 75 frames/sec).
ENTRIES_PER_SECOND = 150

# ── Rekordbox share directory (macOS) ─────────────────────────────────────────
_REKORDBOX_SHARE_DIR = Path.home() / "Library" / "Pioneer" / "rekordbox" / "share"


# ── DB helpers ────────────────────────────────────────────────────────────────

_path_index: dict[str, str] | None = None


def _build_path_index() -> dict[str, str]:
    """Build a ``{FolderPath: AnalysisDataPath}`` lookup from the Rekordbox DB."""
    global _path_index
    if _path_index is not None:
        return _path_index

    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        logger.warning("pyrekordbox not installed — cannot look up ANLZ files")
        _path_index = {}
        return _path_index

    try:
        db = Rekordbox6Database()
    except Exception as exc:
        logger.warning("Failed to open Rekordbox database: %s", exc)
        _path_index = {}
        return _path_index

    index: dict[str, str] = {}
    for track in db.get_content():
        fp = track.FolderPath
        adp = track.AnalysisDataPath
        if fp and adp:
            index[fp] = adp

    _path_index = index
    logger.info("Rekordbox path index built: %d tracks", len(index))
    return _path_index


def _find_anlz_path(audio_path: Path) -> Path | None:
    """Return the ANLZ ``.DAT`` path for *audio_path*, or ``None``."""
    index = _build_path_index()
    adp = index.get(str(audio_path))
    if not adp:
        logger.debug("Track not found in Rekordbox DB: %s", audio_path.name)
        return None

    dat_path = _REKORDBOX_SHARE_DIR / adp.lstrip("/")
    if dat_path.exists():
        return dat_path

    logger.debug("AnalysisDataPath in DB but file missing: %s", dat_path)
    return None


# ── ANLZ parsing ──────────────────────────────────────────────────────────────

def _decode_pwv5_entries(raw_entries: list[int]) -> list[dict]:
    """Decode PWV5 colour-detail 16-bit entries.

    Bit layout (big-endian uint16): ``rrr ggg bbb hhhhh xx``
    """
    result: list[dict] = []
    for v in raw_entries:
        v = int(v)
        r = (v >> 13) & 7
        g = (v >> 10) & 7
        b = (v >> 7) & 7
        h = (v >> 2) & 31
        result.append({
            "height": h / 31.0,
            "r": round(r * _COLOR_SCALE),
            "g": round(g * _COLOR_SCALE),
            "b": round(b * _COLOR_SCALE),
        })
    return result


def _parse_beat_grid(dat_path: Path) -> list[dict]:
    """Parse the PQTZ beat grid from a ``.DAT`` file.

    Returns a list of ``{"beat": int, "tempo": float, "time": float}``
    where *beat* is 1–4 (position within the bar), *tempo* is BPM, and
    *time* is the beat position in seconds.
    """
    try:
        from pyrekordbox.anlz import AnlzFile

        anlz = AnlzFile.parse_file(dat_path)
    except Exception as exc:
        logger.error("Failed to parse ANLZ file %s: %s", dat_path, exc)
        return []

    for tag in anlz.tags:
        if str(tag.type) == "PQTZ":
            beats = list(tag.content.entries)
            return [
                {
                    "beat": int(b.beat),
                    "tempo": int(b.tempo) / 100.0,
                    "time": int(b.time) / 1000.0,
                }
                for b in beats
            ]
    return []


# ── Public API ────────────────────────────────────────────────────────────────

def get_waveform(audio_path: Path) -> dict:
    """Extract colour-detail waveform + beat grid for *audio_path*.

    Returns
    -------
    dict
        - ``"entries"`` – PWV5 colour-detail entries (150/sec)
        - ``"beats"``   – PQTZ beat grid
        - ``"found"``   – whether data was located
        - ``"source"``  – ``"rekordbox_db"`` or ``"none"``
    """
    empty = {"entries": [], "beats": [], "found": False, "source": "none"}

    dat_path = _find_anlz_path(audio_path)
    if dat_path is None:
        return empty

    ext_path = dat_path.with_suffix(".EXT")

    # PWV5 from .EXT
    entries: list[dict] = []
    if ext_path.exists():
        try:
            from pyrekordbox.anlz import AnlzFile

            anlz = AnlzFile.parse_file(ext_path)
            for tag in anlz.tags:
                if str(tag.type) == "PWV5":
                    entries = _decode_pwv5_entries(list(tag.content.entries))
                    break
        except Exception as exc:
            logger.error("Failed to parse EXT file %s: %s", ext_path, exc)

    if not entries:
        logger.warning("No PWV5 data found for %s", audio_path.name)
        return empty

    # Beat grid from .DAT
    beats = _parse_beat_grid(dat_path)

    logger.debug(
        "PWV5: %d entries, PQTZ: %d beats for %s",
        len(entries), len(beats), audio_path.name,
    )
    return {
        "entries": entries,
        "beats": beats,
        "found": True,
        "source": "rekordbox_db",
    }
