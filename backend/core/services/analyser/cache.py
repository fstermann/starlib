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
import time
from dataclasses import dataclass
from pathlib import Path

from backend.config import get_backend_settings
from backend.core.services.metadata import _find_ffmpeg

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AnalyserCacheConfig:
    """Tunables for the analyser cache; resolved from `BackendSettings`."""

    sets_dir: Path
    slices_dir: Path
    max_total_bytes: int = 5 * 1024 * 1024 * 1024  # 5 GB
    set_ttl_seconds: float = 30 * 24 * 3600  # 30 days

    @classmethod
    def from_settings(cls) -> "AnalyserCacheConfig":
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
    """
    existing = cached_set_path(soundcloud_id)
    if existing is not None:
        return existing

    cfg = _config()
    out = cfg.sets_dir / f"{soundcloud_id}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)

    ffmpeg = _find_ffmpeg()
    cmd: list[str] = [ffmpeg, "-y"]
    if auth_header:
        cmd.extend(["-headers", f"Authorization: {auth_header}\r\n"])
    cmd.extend(
        [
            "-i", hls_url,
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc",
            "-f", "mp4",
            str(out),
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
        if out.exists():
            out.unlink()
        raise RuntimeError(
            f"ffmpeg HLS download failed (exit {proc.returncode}): {stderr.decode(errors='replace')[:512]}"
        )

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

    Returns the path to a cached mp3 ready to hand to a Shazam client.
    Cached by ``(job_id, section_index, pitch_semitones)`` — re-running
    Shazam with the same parameters never re-spends ffmpeg cycles.

    Pitch-shift uses the ``asetrate``/``aresample``/``atempo`` chain rather
    than the rubberband filter so we don't take a libraseq dependency. This
    is good enough for Shazam matching: the latter cares about the spectral
    fingerprint, not psychoacoustic transparency.
    """
    cfg = _config()
    job_dir = cfg.slices_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    pitch_tag = f"{pitch_semitones:+.2f}"
    out = job_dir / f"section-{section_index}-pitch-{pitch_tag}.mp3"
    if out.exists():
        return out

    ffmpeg = _find_ffmpeg()
    cmd: list[str] = [
        ffmpeg, "-y",
        "-ss", f"{start_s:.3f}",
        "-t", f"{duration_s:.3f}",
        "-i", str(source),
    ]
    if pitch_semitones != 0.0:
        # asetrate scales sample rate (changes pitch + tempo together);
        # atempo undoes the tempo change so only pitch shifts. Stack atempo
        # filters when the ratio is outside [0.5, 2.0] (atempo's clamped range).
        ratio = 2.0 ** (pitch_semitones / 12.0)
        # Inverse ratio for tempo correction.
        tempo_chain = _atempo_chain(1.0 / ratio)
        af = f"asetrate=44100*{ratio},aresample=44100,{tempo_chain}"
        cmd.extend(["-af", af])
    cmd.extend(["-acodec", "libmp3lame", "-q:a", "5", str(out)])

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
    return out


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
