"""Shazam client wrapper used by the analyser pipeline.

The default implementation talks to Shazam through `shazamio`_ — a
reverse-engineered client over Shazam's mobile API. It's free and async-
friendly but the endpoint is undocumented and rate-limited at undisclosed
levels. We treat it as best-effort:

- Hard cap on concurrent in-flight queries (start: ``2``).
- Per-job token bucket at ``1 req/s``.
- Exponential backoff with jitter on transient failures.
- Result caching is the *caller's* responsibility (``analyser.db``
  ``upsert_track_id`` / ``get_track_id``) — this module just makes the
  network call.

The implementation is hidden behind a :class:`ShazamClient` Protocol so the
rest of the codebase never imports `shazamio` directly. Tests inject an
in-memory fake; production swaps in :class:`ShazamioClient`. If `shazamio`
isn't installed (e.g. in CI when the optional dep is missing) the public
``get_default_client`` factory returns a :class:`MissingShazamClient` that
records the call and surfaces a useful error rather than crashing at
import time.

.. _shazamio: https://github.com/shazamio/ShazamIO
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class ShazamMatch:
    """Outcome of one Shazam recognition call."""

    title: str | None
    artist: str | None
    shazam_id: str | None
    confidence: float


class ShazamClient(Protocol):
    """Async Shazam recognition interface."""

    async def match(self, audio_path: str) -> ShazamMatch | None:
        """Recognise the audio at ``audio_path``.

        Returns ``None`` when Shazam returns no match — distinct from
        raising an error, which signals a transport/rate-limit failure
        the caller may retry.
        """
        ...


# ---------------------------------------------------------------------------
# Token bucket
# ---------------------------------------------------------------------------


class TokenBucket:
    """Asyncio-friendly token bucket.

    Lets a job request ``rate`` tokens per second with a burst capacity of
    ``capacity``. Used to keep Shazam calls under the (undocumented) rate
    threshold while letting one-off bursts through. Multiple workers can
    share a bucket.
    """

    def __init__(self, *, rate: float, capacity: float) -> None:
        if rate <= 0:
            raise ValueError("rate must be positive")
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._rate = rate
        self._capacity = capacity
        self._tokens = capacity
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, tokens: float = 1.0) -> None:
        if tokens > self._capacity:
            raise ValueError("requested tokens exceed bucket capacity")
        while True:
            async with self._lock:
                now = time.monotonic()
                elapsed = now - self._last_refill
                self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
                self._last_refill = now
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return
                wait = (tokens - self._tokens) / self._rate
            await asyncio.sleep(wait)


# ---------------------------------------------------------------------------
# Concrete clients
# ---------------------------------------------------------------------------


class MissingShazamClient:
    """Placeholder used when ``shazamio`` isn't installed.

    Lets the rest of the analyser pipeline import + run without crashing;
    Shazam stage logs a warning and skips identification. The API surface
    matches :class:`ShazamClient`.
    """

    async def match(self, audio_path: str) -> ShazamMatch | None:
        logger.warning("shazam: shazamio not installed; skipping recognition for %s", audio_path)
        return None


class ShazamioClient:
    """Real `shazamio`_ client with retry + backoff."""

    def __init__(self, *, max_attempts: int = 3, base_backoff_s: float = 1.5) -> None:
        from shazamio import Shazam  # type: ignore[import-not-found]  # optional dep

        self._shazam = Shazam()
        self._max_attempts = max_attempts
        self._base_backoff_s = base_backoff_s

    async def match(self, audio_path: str) -> ShazamMatch | None:
        attempt = 0
        while True:
            attempt += 1
            try:
                raw = await self._shazam.recognize(audio_path)
            except Exception as exc:  # broad: shazamio raises a mix of transport errors
                if attempt >= self._max_attempts:
                    raise
                delay = self._base_backoff_s * (2 ** (attempt - 1))
                # Full jitter to avoid synchronised retries from a worker pool.
                delay *= 0.5 + random.random()
                logger.warning(
                    "shazam: attempt %d/%d failed (%s); backing off %.2fs",
                    attempt,
                    self._max_attempts,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)
                continue
            return _parse_shazamio_response(raw)


def _parse_shazamio_response(raw: dict | None) -> ShazamMatch | None:
    """Map a shazamio response dict to :class:`ShazamMatch`.

    shazamio's payload mirrors Shazam's — useful keys live under
    ``track``: ``title``, ``subtitle`` (artist), ``key`` (id), and a nested
    ``hub`` carrying confidence-ish metadata. shazamio doesn't surface a
    direct numeric confidence, so we synthesise one from the response
    shape: a populated ``track.key`` plus a non-empty ``hub.actions`` is
    treated as ``0.95``; ``track`` populated but no ``hub`` is ``0.6``.
    No track at all → ``None``.
    """
    if not isinstance(raw, dict):
        return None
    track = raw.get("track")
    if not isinstance(track, dict):
        return None
    title = track.get("title")
    artist = track.get("subtitle")
    shazam_id = track.get("key")
    has_hub = bool(track.get("hub", {}).get("actions"))
    confidence = 0.95 if has_hub else 0.6
    return ShazamMatch(
        title=title,
        artist=artist,
        shazam_id=str(shazam_id) if shazam_id is not None else None,
        confidence=confidence,
    )


def get_default_client() -> ShazamClient:
    """Return a usable :class:`ShazamClient`, falling back gracefully."""
    try:
        return ShazamioClient()
    except ImportError:
        return MissingShazamClient()


# ---------------------------------------------------------------------------
# Concurrency wrapper
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class RateLimitedClient:
    """Token-bucketed + concurrency-bounded wrapper around any ShazamClient."""

    inner: ShazamClient
    bucket: TokenBucket
    semaphore: asyncio.Semaphore

    async def match(self, audio_path: str) -> ShazamMatch | None:
        await self.bucket.acquire()
        async with self.semaphore:
            return await self.inner.match(audio_path)


def build_rate_limited_client(
    inner: ShazamClient,
    *,
    rate_per_second: float = 1.0,
    burst: float = 2.0,
    max_concurrent: int = 2,
) -> RateLimitedClient:
    return RateLimitedClient(
        inner=inner,
        bucket=TokenBucket(rate=rate_per_second, capacity=burst),
        semaphore=asyncio.Semaphore(max_concurrent),
    )
