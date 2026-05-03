"""On-disk audio cache for the analyser pipeline.

Two tiers:

1. **Set audio**: a single concatenated fMP4 / mp3 per analysed SoundCloud
   set, downloaded once by piping the HLS playlist through ffmpeg's stream
   copy. Stored under ``<cache_dir>/analyser/sets/<soundcloud_id>.<ext>``.
   LRU-evicted by total directory size (default cap 5 GB).
2. **Pitch-corrected slices** for Shazam queries: produced by extracting a
   12 s window from the set audio and (optionally) pitch-shifting it via
   ffmpeg's ``rubberband``-style filter chain. Stored under
   ``<cache_dir>/analyser/slices/<job_id>/<section>-<pitch>.mp3``. Evicted
   alongside the parent job.

Both tiers shell out to ffmpeg (the same binary located by
:func:`backend.core.services.metadata._find_ffmpeg`). The parent /streams
URL is fetched via the existing helpers in ``backend.api.soundcloud``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from backend.config import get_backend_settings
from backend.core.services.metadata import _find_ffmpeg

logger = logging.getLogger(__name__)

# Per-soundcloud-id locks for ``fetch_set_audio``. Two concurrent jobs
# pointing at the same set must serialise on the download — otherwise both
# spawn ffmpeg over the same destination path and corrupt the cached file.
_set_audio_locks: dict[int, asyncio.Lock] = {}
_set_audio_locks_guard = asyncio.Lock()


async def _set_audio_lock(soundcloud_id: int) -> asyncio.Lock:
    async with _set_audio_locks_guard:
        lock = _set_audio_locks.get(soundcloud_id)
        if lock is None:
            lock = asyncio.Lock()
            _set_audio_locks[soundcloud_id] = lock
        return lock


def _find_ffprobe() -> str:
    """Locate ``ffprobe`` using the same priority order as ``_find_ffmpeg``."""
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / "ffprobe"  # type: ignore[attr-defined]
        if bundled.exists():
            return str(bundled)
    for candidate in (
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "ffprobe",
    ):
        found = shutil.which(candidate)
        if found:
            return found
    return "ffprobe"


_PROBE_CACHE_MAX = 256
_probe_cache: dict[tuple[str, float], int] = {}


async def _probe_sample_rate(path: Path) -> int:
    """Return the first audio stream's sample rate, falling back to 44100.

    The pitch-shift filter chain hardcoded 44100 prior — that miscalibrates
    every non-44.1 kHz source (SoundCloud commonly serves 48 kHz). Probing
    keeps the asetrate / aresample pair in lock-step with the input.

    Memoised per ``(path, mtime)`` so a Shazam scan that hits the same
    cached audio for hundreds of slices doesn't shell out to ffprobe each
    time.
    """
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    key = (str(path), mtime)
    cached = _probe_cache.get(key)
    if cached is not None:
        return cached
    ffprobe = _find_ffprobe()
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate",
        "-of",
        "csv=p=0",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    rate = 44100
    if proc.returncode == 0:
        text = stdout.decode(errors="replace").strip().splitlines()
        if text:
            try:
                parsed = int(text[0])
                if parsed > 0:
                    rate = parsed
            except ValueError:
                pass
    if len(_probe_cache) >= _PROBE_CACHE_MAX:
        # Bound memory growth in long-running processes; the cache is keyed
        # by (path, mtime) so entries become useless after re-download.
        _probe_cache.pop(next(iter(_probe_cache)))
    _probe_cache[key] = rate
    return rate


@dataclass(slots=True)
class AnalyserCacheConfig:
    """Tunables for the analyser cache; resolved from `BackendSettings`."""

    sets_dir: Path
    slices_dir: Path
    max_total_bytes: int = 5 * 1024 * 1024 * 1024  # 5 GB
    set_ttl_seconds: float = 30 * 24 * 3600  # 30 days

    @classmethod
    def from_settings(cls) -> AnalyserCacheConfig:
        settings = get_backend_settings()
        base = settings.cache_dir / "analyser"
        return cls(
            sets_dir=base / "sets",
            slices_dir=base / "slices",
        )


def _config() -> AnalyserCacheConfig:
    cfg = AnalyserCacheConfig.from_settings()
    cfg.sets_dir.mkdir(parents=True, exist_ok=True)
    cfg.slices_dir.mkdir(parents=True, exist_ok=True)
    return cfg


# ---------------------------------------------------------------------------
# Set audio
# ---------------------------------------------------------------------------


def cached_set_path(soundcloud_id: int) -> Path | None:
    """Return the on-disk path of a cached set, or ``None`` if not cached."""
    cfg = _config()
    for ext in ("mp4", "m4a", "mp3"):
        cand = cfg.sets_dir / f"{soundcloud_id}.{ext}"
        if cand.exists():
            try:
                os.utime(cand, None)  # touch for LRU.
            except OSError:
                pass
            return cand
    return None


async def fetch_set_audio(
    soundcloud_id: int,
    *,
    hls_url: str,
    auth_header: str | None = None,
) -> Path:
    """Ensure the set's audio is on disk and return the path.

    Uses ffmpeg's stream-copy mode to download all HLS segments into a
    single mp4 container without re-encoding (preserves the AAC payload
    bit-exact). Idempotent: if the cache already has a file for this id we
    return it immediately.

    Concurrent calls for the same ``soundcloud_id`` serialise on a per-id
    asyncio lock so two jobs can't race ffmpeg processes onto the same
    output path.
    """
    existing = cached_set_path(soundcloud_id)
    if existing is not None:
        return existing

    lock = await _set_audio_lock(soundcloud_id)
    async with lock:
        # Re-check inside the lock: a sibling caller may have downloaded
        # while we were waiting.
        existing = cached_set_path(soundcloud_id)
        if existing is not None:
            return existing

        cfg = _config()
        out = cfg.sets_dir / f"{soundcloud_id}.mp4"
        # Write to a sibling ``.part`` and rename on success so the
        # ``/audio`` endpoint never sees a half-written file (otherwise
        # FileResponse stats a smaller size and uvicorn raises
        # "Response content longer than Content-Length" once ffmpeg
        # appends more bytes mid-stream).
        partial = out.with_suffix(out.suffix + ".part")
        out.parent.mkdir(parents=True, exist_ok=True)
        if partial.exists():
            partial.unlink()

        ffmpeg = _find_ffmpeg()
        cmd: list[str] = [ffmpeg, "-y"]
        if auth_header:
            cmd.extend(["-headers", f"Authorization: {auth_header}\r\n"])
        cmd.extend(
            [
                "-i",
                hls_url,
                "-c",
                "copy",
                "-bsf:a",
                "aac_adtstoasc",
                # Move the moov atom to the front of the file so subsequent
                # ffmpeg seeks (per scan-point slice extraction) don't have
                # to scan to the end of a several-hundred-MB file to find
                # the index. Negligible cost on the download itself.
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                str(partial),
            ]
        )
        logger.info("downloading SoundCloud set %s via ffmpeg → %s", soundcloud_id, out)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            # Don't leave a half-written file in the cache.
            if partial.exists():
                partial.unlink()
            raise RuntimeError(
                f"ffmpeg HLS download failed (exit {proc.returncode}): {stderr.decode(errors='replace')[:512]}"
            )

        partial.replace(out)
        enforce_size_cap()
        return out


def enforce_size_cap() -> None:
    """LRU eviction: drop oldest files (by mtime) until total size ≤ cap."""
    cfg = _config()
    files: list[tuple[float, Path, int]] = []
    total = 0
    for p in cfg.sets_dir.iterdir():
        if not p.is_file():
            continue
        st = p.stat()
        files.append((st.st_mtime, p, st.st_size))
        total += st.st_size

    if total <= cfg.max_total_bytes:
        return
    files.sort()  # oldest first
    for _mtime, p, size in files:
        if total <= cfg.max_total_bytes:
            return
        try:
            p.unlink()
            total -= size
            logger.info("analyser cache LRU evicted %s (%d bytes)", p.name, size)
        except OSError as exc:
            logger.warning("LRU evict failed for %s: %s", p, exc)


def prune_orphaned_slices(active_job_ids: set[str]) -> int:
    """Delete slice subdirectories for jobs that are no longer in the DB.

    Called from the analyser's startup task. Returns the number of
    directories removed.
    """
    cfg = _config()
    removed = 0
    if not cfg.slices_dir.exists():
        return 0
    for entry in cfg.slices_dir.iterdir():
        if not entry.is_dir():
            continue
        if entry.name in active_job_ids:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        removed += 1
    return removed


# ---------------------------------------------------------------------------
# Pitch-corrected slices for Shazam
# ---------------------------------------------------------------------------


async def make_shazam_slice(
    *,
    job_id: str,
    section_index: int,
    source: Path,
    start_s: float,
    duration_s: float = 12.0,
    pitch_semitones: float = 0.0,
) -> Path:
    """Carve a 12 s slice out of ``source`` and (optionally) pitch-shift it.

    Two-stage extraction so a scan point with a ``range`` pitch strategy
    (3 attempts) doesn't re-seek the big set audio three times:

    1. **Base slice** — one ffmpeg pass to copy 12 s of the source into a
       small mp3, cached at ``section-N-base.mp3``. Re-used across pitch
       attempts at the same point.
    2. **Pitched variant** — for non-zero ``pitch_semitones``, a second
       ffmpeg pass that runs the ``asetrate``/``aresample``/``atempo``
       chain on the small base slice (cheap because the input is already
       only 12 s of audio).

    The cached SoundCloud mp4 ships with its ``moov`` atom at the end
    (no ``-movflags +faststart`` on the HLS stream-copy), so seeking it
    is the dominant cost; reading the small base slice repeatedly is
    near-free in comparison.

    Pitch-shift uses ``asetrate``/``aresample``/``atempo`` rather than
    rubberband so we don't take a librubberband dependency — this is
    good enough for Shazam matching, which cares about the spectral
    fingerprint, not psychoacoustic transparency.
    """
    cfg = _config()
    job_dir = cfg.slices_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    base_path = job_dir / f"section-{section_index}-base.mp3"
    if not base_path.exists():
        await _extract_base_slice(source=source, start_s=start_s, duration_s=duration_s, out=base_path)

    if pitch_semitones == 0.0:
        return base_path

    pitch_tag = f"{pitch_semitones:+.2f}"
    out = job_dir / f"section-{section_index}-pitch-{pitch_tag}.mp3"
    if out.exists():
        return out
    await _shift_pitch_from_base(base=base_path, out=out, pitch_semitones=pitch_semitones)
    return out


async def _extract_base_slice(
    *,
    source: Path,
    start_s: float,
    duration_s: float,
    out: Path,
) -> None:
    """One ffmpeg pass: ``[start_s, start_s+duration_s]`` of ``source`` → mp3."""
    ffmpeg = _find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        f"{start_s:.3f}",
        "-t",
        f"{duration_s:.3f}",
        "-i",
        str(source),
        "-acodec",
        "libmp3lame",
        "-q:a",
        "5",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        if out.exists():
            out.unlink()
        raise RuntimeError(
            f"ffmpeg slice extraction failed (exit {proc.returncode}): {stderr.decode(errors='replace')[:512]}"
        )


async def _shift_pitch_from_base(
    *,
    base: Path,
    out: Path,
    pitch_semitones: float,
) -> None:
    """ffmpeg pass over the small base slice to produce a pitched variant.

    Runs the asetrate / aresample / atempo filter chain on ``base``
    (~12 s of audio) which is cheap regardless of how the original
    container was indexed.
    """
    ratio = 2.0 ** (pitch_semitones / 12.0)
    tempo_chain = _atempo_chain(1.0 / ratio)
    source_sr = await _probe_sample_rate(base)
    af = f"asetrate={source_sr}*{ratio},aresample={source_sr},{tempo_chain}"
    ffmpeg = _find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(base),
        "-af",
        af,
        "-acodec",
        "libmp3lame",
        "-q:a",
        "5",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        if out.exists():
            out.unlink()
        raise RuntimeError(
            f"ffmpeg pitch shift failed (exit {proc.returncode}): {stderr.decode(errors='replace')[:512]}"
        )


def _atempo_chain(ratio: float) -> str:
    """Build a chain of ``atempo`` filters whose product is ``ratio``.

    ffmpeg's ``atempo`` clamps each instance to ``[0.5, 2.0]``; for ratios
    outside that range we stack multiple instances. Returns a string like
    ``atempo=0.5,atempo=0.94`` joined with commas.
    """
    if 0.5 <= ratio <= 2.0:
        return f"atempo={ratio:.6f}"
    chain: list[str] = []
    remaining = ratio
    while remaining < 0.5:
        chain.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 2.0:
        chain.append("atempo=2.0")
        remaining /= 2.0
    chain.append(f"atempo={remaining:.6f}")
    return ",".join(chain)


def slice_dir_for_job(job_id: str) -> Path:
    cfg = _config()
    return cfg.slices_dir / job_id


def slice_age_seconds(path: Path) -> float:
    return max(0.0, time.time() - path.stat().st_mtime)
