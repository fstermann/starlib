"""Audio streaming and waveform peaks for the Meta Editor."""

import asyncio
import logging
import subprocess
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

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
    num_peaks: int = Query(200, ge=50, le=500, description="Number of amplitude peaks to return"),
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
        cached = cache_db.get_peaks(resolved_path, mtime)
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


@router.get("/files/{file_path:path}/audio")
def stream_audio(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> StreamingResponse:
    """Stream an audio file.

    Formats not natively supported by browsers (e.g. AIFF) are
    transcoded to WAV on the fly via ffmpeg.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    StreamingResponse
        Audio file bytes

    Raises
    ------
    HTTPException
        If the file doesn't exist
    """
    resolved_path = validate_file_path(file_path, root_folder)

    if not resolved_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")

    if resolved_path.suffix.lower() in _TRANSCODE_EXTENSIONS:
        return _stream_transcoded(resolved_path)

    mime_type = AUDIO_MIME_TYPES.get(resolved_path.suffix.lower(), "application/octet-stream")

    def iter_file():
        with open(resolved_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type=mime_type,
        headers={
            "Content-Disposition": f'inline; filename="{resolved_path.name}"',
            "Content-Length": str(resolved_path.stat().st_size),
            "Accept-Ranges": "bytes",
        },
    )


def _stream_transcoded(path: Path) -> StreamingResponse:
    """Transcode an audio file to WAV via ffmpeg and stream it."""
    proc = subprocess.Popen(
        ["ffmpeg", "-i", str(path), "-f", "wav", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    def iterfile():
        assert proc.stdout is not None
        try:
            while chunk := proc.stdout.read(65536):
                yield chunk
        finally:
            proc.stdout.close()
            proc.wait()

    stem = path.stem
    return StreamingResponse(
        iterfile(),
        media_type="audio/wav",
        headers={"Content-Disposition": f'inline; filename="{stem}.wav"'},
    )
