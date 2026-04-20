"""SoundCloud HLS stream URL endpoint.

Provides a signed, short-lived HLS playlist URL for a SoundCloud track,
fetched from the public SoundCloud API via OAuth client credentials.
Responses are cached in-memory for ~30 minutes to avoid hammering the
upstream API and to keep client playback start-up snappy.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from soundcloud_tools.client import Client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud", tags=["soundcloud"])

# Default cache TTL (seconds). Signed CDN URLs from SoundCloud typically
# live for ~1 hour; we refresh every 30 minutes to be safe.
_DEFAULT_TTL_SECONDS = 30 * 60


class StreamUrlResponse(BaseModel):
    """Signed HLS stream URL for a SoundCloud track."""

    url: str
    expires_at: str


@dataclass
class _CacheEntry:
    url: str
    expires_at: float  # unix epoch seconds


# In-memory per-track cache. Keyed by track_id.
_cache: dict[int, _CacheEntry] = {}
_cache_lock = asyncio.Lock()


def _extract_expires_from_url(url: str) -> float | None:
    """Extract the `expires` epoch query param from a signed URL, if any."""
    try:
        qs = parse_qs(urlparse(url).query)
        expires_values = qs.get("expires")
        if expires_values:
            return float(expires_values[0])
    except (ValueError, TypeError):
        pass
    return None


async def _fetch_stream_url(track_id: int, client: Client | None = None) -> tuple[str, float]:
    """Fetch a fresh HLS stream URL for a track from the SoundCloud API.

    Parameters
    ----------
    track_id : int
        SoundCloud track id.
    client : Client, optional
        SoundCloud API client. Creates a default client when omitted.

    Returns
    -------
    tuple[str, float]
        `(url, expires_at)` where `expires_at` is a unix epoch timestamp.

    Raises
    ------
    HTTPException
        404 if no HLS variant is available; 502 on upstream errors.
    """
    if client is None:
        client = Client()

    url = client.make_url("tracks/{track_id}/streams", track_id=str(track_id))
    try:
        response = await client.make_request("GET", url, allow_redirects=False)
    except Exception as exc:  # pragma: no cover - network transport
        logger.exception("Upstream SoundCloud request failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud upstream error: {exc}",
        ) from exc

    if response.status_code != 200:
        logger.warning("SoundCloud /streams returned %s for track %s", response.status_code, track_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud returned {response.status_code}",
        )

    data = response.json()
    stream_url = data.get("hls_aac_160_url") or data.get("hls_mp3_128_url")
    if not stream_url:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No HLS stream variant available for this track",
        )

    # The returned URL on api.soundcloud.com redirects to the signed CDN
    # playlist. Try to follow one hop (without downloading the playlist) to
    # extract the signed `expires` epoch, which gives us an accurate TTL.
    final_url = stream_url
    expires_epoch: float | None = None
    try:
        redirect_resp = await client.make_request("GET", stream_url, allow_redirects=False)
        loc = redirect_resp.headers.get("Location") or redirect_resp.headers.get("location")
        if loc:
            final_url = loc
            expires_epoch = _extract_expires_from_url(loc)
    except Exception:  # pragma: no cover - best-effort redirect follow
        logger.debug("Could not pre-resolve signed CDN URL; returning api.soundcloud.com URL")

    if expires_epoch is None:
        expires_epoch = time.time() + _DEFAULT_TTL_SECONDS

    return final_url, expires_epoch


@router.get("/tracks/{track_id}/stream", response_model=StreamUrlResponse)
async def get_track_stream(track_id: int) -> StreamUrlResponse:
    """Return a signed HLS playlist URL for the given SoundCloud track.

    The result is cached in-memory and reused while still valid. Expired
    entries are transparently refetched.

    Parameters
    ----------
    track_id : int
        SoundCloud track id.

    Returns
    -------
    StreamUrlResponse
        `url` is the `.m3u8` playlist URL; `expires_at` is an ISO-8601
        UTC timestamp after which the client should refetch.
    """
    now = time.time()

    async with _cache_lock:
        entry = _cache.get(track_id)
        # Treat anything expiring in <60s as stale so clients don't race the expiry.
        if entry and entry.expires_at - now > 60:
            expires_dt = datetime.fromtimestamp(entry.expires_at, tz=UTC)
            return StreamUrlResponse(url=entry.url, expires_at=expires_dt.isoformat())

        url, expires_at = await _fetch_stream_url(track_id)
        # Clamp cache TTL to our default even if upstream hands us a longer window.
        capped_expires = min(expires_at, now + _DEFAULT_TTL_SECONDS)
        _cache[track_id] = _CacheEntry(url=url, expires_at=capped_expires)

    expires_dt = datetime.fromtimestamp(capped_expires, tz=UTC)
    return StreamUrlResponse(url=url, expires_at=expires_dt.isoformat())


def _reset_cache_for_tests() -> None:
    """Clear the in-memory cache. Intended for tests only."""
    _cache.clear()
