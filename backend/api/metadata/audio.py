"""Audio streaming and waveform peaks for the Meta Editor."""

import asyncio
import hashlib
import logging
import subprocess
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse

from backend.api.deps import get_root_folder, validate_file_path
from backend.config import get_backend_settings
from backend.core.services import cache_db, metadata
from backend.schemas.metadata import PeaksResponse

logger = logging.getLogger(__name__)

router = APIRouter()

AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}

# Formats that Chrome cannot decode natively — transcode to WAV via ffmpeg.
_TRANSCODE_EXTENSIONS = {".aiff", ".aif"}

# Limit concurrent ffmpeg peak-computation processes so uncached requests
# don't overwhelm the server. Cached requests bypass this semaphore entirely.
_peaks_semaphore = asyncio.Semaphore(4)


@router.get("/files/{file_path:path}/peaks", response_model=PeaksResponse)
async def get_file_peaks(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
    num_peaks: int = Query(200, ge=50, le=2000, description="Number of amplitude peaks to return"),
) -> PeaksResponse:
    """Get waveform amplitude peak data for a file.

    Cached results (SQLite) are returned immediately without any throttle.
    Uncached files are decoded via ffmpeg; concurrent ffmpeg calls are capped
    at 4 to avoid overwhelming the system during fast scrolling.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)
    num_peaks : int
        Number of peak values to return

    Returns
    -------
    PeaksResponse
        Normalized peak amplitudes in range [0, 1]
    """
    resolved_path = validate_file_path(file_path, root_folder)

    if not resolved_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")

    # Fast path — serve from SQLite cache without touching the semaphore.
    try:
        mtime = resolved_path.stat().st_mtime
        cached = cache_db.get_peaks(resolved_path, mtime, num_peaks)
        if cached is not None:
            return PeaksResponse(peaks=cached)
    except OSError:
        pass

    # Slow path — throttled ffmpeg computation.
    settings = get_backend_settings()
    loop = asyncio.get_event_loop()
    try:
        async with _peaks_semaphore:
            peaks = await loop.run_in_executor(
                None, metadata.get_waveform_peaks, resolved_path, settings.cache_dir, num_peaks
            )
    except Exception as e:
        logger.exception("Failed to compute peaks")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to compute peaks",
        ) from e

    return PeaksResponse(peaks=peaks)


@router.get("/files/{file_path:path}/audio", response_model=None)
async def stream_audio(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FileResponse:
    """Stream an audio file.

    Formats not natively supported by browsers (e.g. AIFF) are transcoded to
    WAV via ffmpeg and cached.  Transcoding is awaited before responding so
    that the browser always receives a real file with Content-Length and range
    support, which is required for seeking to work.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    FileResponse
        Audio file bytes

    Raises
    ------
    HTTPException
        If the file doesn't exist or transcoding fails
    """
    resolved_path = validate_file_path(file_path, root_folder)

    if not resolved_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")

    if resolved_path.suffix.lower() in _TRANSCODE_EXTENSIONS:
        settings = get_backend_settings()
        wav_path = _cached_wav_path(resolved_path, settings.cache_dir)
        if not wav_path.exists():
            loop = asyncio.get_event_loop()
            try:
                await loop.run_in_executor(None, _transcode_to_wav, resolved_path, wav_path)
            except Exception as e:
                logger.exception("Failed to transcode audio file")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to transcode audio file",
                ) from e
        return FileResponse(
            wav_path,
            media_type="audio/wav",
            headers={"Content-Disposition": f'inline; filename="{resolved_path.stem}.wav"'},
        )

    mime_type = AUDIO_MIME_TYPES.get(resolved_path.suffix.lower(), "application/octet-stream")

    return FileResponse(
        resolved_path,
        media_type=mime_type,
        headers={"Content-Disposition": f'inline; filename="{resolved_path.name}"'},
    )


def _cached_wav_path(path: Path, cache_dir: Path) -> Path:
    """Return the expected cache path for a transcoded WAV without creating it."""
    mtime = int(path.stat().st_mtime)
    digest = hashlib.sha256(str(path.resolve()).encode()).hexdigest()[:16]
    transcoded_dir = cache_dir / "transcoded"
    transcoded_dir.mkdir(parents=True, exist_ok=True)
    # Remove stale entries for this file (different mtime).
    for stale in transcoded_dir.glob(f"{digest}_*.wav"):
        if stale.name != f"{digest}_{mtime}.wav":
            stale.unlink(missing_ok=True)
    return transcoded_dir / f"{digest}_{mtime}.wav"


def _transcode_to_wav(path: Path, wav_path: Path) -> None:
    """Transcode *path* to a WAV file at *wav_path* using ffmpeg."""
    tmp_path = wav_path.with_suffix(".tmp")
    try:
        subprocess.run(
            ["ffmpeg", "-i", str(path), "-f", "wav", str(tmp_path), "-y"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        tmp_path.rename(wav_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
