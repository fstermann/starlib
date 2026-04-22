"""SoundCloud HLS stream URL endpoint.

Provides a signed, short-lived HLS playlist URL for a SoundCloud track,
fetched from the public SoundCloud API via OAuth Client Credentials.
Responses are cached in-memory for ~30 minutes to avoid hammering the
upstream API and to keep client playback start-up snappy.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from backend.core.services import sc_auth_cache
from soundcloud_tools.oauth import OAuthManager  # re-exported for tests
from soundcloud_tools.settings import get_settings  # re-exported for tests

__all__ = ["OAuthManager", "get_settings", "router"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud", tags=["soundcloud"])

# Client-Credentials OAuth tokens are rejected by api-v2.soundcloud.com; the
# public API at api.soundcloud.com accepts them.
_PUBLIC_API_BASE = "https://api.soundcloud.com"

# Default cache TTL (seconds). Signed CDN URLs live ~1 hour; refresh at 30 min.
_DEFAULT_TTL_SECONDS = 30 * 60

# HTTP timeout for upstream SoundCloud calls. Overridable via env var for ops.
_HTTP_TIMEOUT_SECONDS: float = float(os.environ.get("STARLIB_SC_HTTP_TIMEOUT", "15"))

# Allowlist of hosts the `/streams` endpoint may redirect us to. We follow
# only these on the redirect hop so a spoofed upstream can't bounce us to a
# malicious origin. Matches exact host OR any subdomain of an entry.
_ALLOWED_REDIRECT_SUFFIXES: tuple[str, ...] = (
    "sndcdn.com",
    "soundcloud.cloud",
    "soundcloud.com",
)
_ALLOWED_REDIRECT_HOSTS: tuple[str, ...] = (
    "cf-hls-media.sndcdn.com",
    "playback.media-streaming.soundcloud.cloud",
)


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

# Per-track in-flight locks prevent a thundering herd of concurrent misses
# all calling `_fetch_stream_url` for the same track.
_inflight_locks: dict[int, asyncio.Lock] = {}
_inflight_locks_guard = asyncio.Lock()


def _is_allowed_redirect_host(host: str | None) -> bool:
    """Return True iff the given host matches the SoundCloud CDN allowlist."""
    if not host:
        return False
    host = host.lower()
    if host in _ALLOWED_REDIRECT_HOSTS:
        return True
    return any(host == suffix or host.endswith("." + suffix) for suffix in _ALLOWED_REDIRECT_SUFFIXES)


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


async def _http_get(url: str, *, token: str, follow_redirects: bool) -> httpx.Response:
    """Authenticated GET against the SoundCloud public API.

    Uses only the `Authorization: OAuth <token>` header — deliberately omits
    the web-client `client_id`/`app_version` query params that the
    ``soundcloud_tools.Client`` injects, because the public API drops the
    Authorization header and returns 401 when those are present.
    """
    headers = {"Authorization": f"OAuth {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
        return await client.get(url, headers=headers, follow_redirects=follow_redirects)


async def _fetch_stream_url(track_id: int) -> tuple[str, float]:
    """Fetch a fresh HLS stream URL for a track from the SoundCloud API.

    Parameters
    ----------
    track_id : int
        SoundCloud track id.

    Returns
    -------
    tuple[str, float]
        ``(url, expires_at)`` where ``expires_at`` is a unix epoch timestamp.

    Raises
    ------
    HTTPException
        404 if no HLS variant is available; 502 on upstream errors.
    """
    settings = get_settings()
    if not settings.has_oauth_credentials():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud OAuth credentials not configured",
        )
    try:
        token = sc_auth_cache.get_cached_access_token(settings, OAuthManager)
    except Exception as exc:
        logger.exception("Failed to acquire SoundCloud OAuth token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud auth unavailable",
        ) from exc

    streams_url = f"{_PUBLIC_API_BASE}/tracks/{track_id}/streams"
    try:
        response = await _http_get(streams_url, token=token, follow_redirects=True)
    except Exception as exc:  # pragma: no cover - network transport
        logger.exception("Upstream SoundCloud request failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud upstream error",
        ) from exc

    # SoundCloud can invalidate a still-cached Client-Credentials token
    # before its nominal expiry (observed in practice). On 401, wipe the
    # cache, mint a fresh token, and retry once — avoids forcing the user
    # through the full user-OAuth flow just to keep playback alive.
    if response.status_code == 401:
        logger.info("SoundCloud /streams 401 for track %s — refreshing token and retrying", track_id)
        sc_auth_cache.reset_cache()
        try:
            token = sc_auth_cache.get_cached_access_token(settings, OAuthManager)
            response = await _http_get(streams_url, token=token, follow_redirects=True)
        except Exception as exc:
            logger.exception("Retry after SoundCloud 401 failed")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="SoundCloud auth retry failed",
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

    final_url, expires_epoch = await _resolve_signed_cdn_url(stream_url, token=token, track_id=track_id)
    if expires_epoch is None:
        expires_epoch = time.time() + _DEFAULT_TTL_SECONDS
    return final_url, expires_epoch


async def _resolve_signed_cdn_url(stream_url: str, *, token: str, track_id: int) -> tuple[str, float | None]:
    """Follow one redirect hop to the signed CDN URL, enforcing the allowlist.

    The /streams response points to another api.soundcloud.com URL that 302s
    to the signed CDN playlist. We resolve that hop without downloading the
    playlist so we can extract the `expires` epoch — and reject redirects
    whose host isn't on our SoundCloud CDN allowlist.
    """
    try:
        redirect_resp = await _http_get(stream_url, token=token, follow_redirects=False)
    except Exception:  # pragma: no cover - best-effort redirect follow
        logger.debug("Could not pre-resolve signed CDN URL; returning api.soundcloud.com URL")
        return stream_url, None

    loc = redirect_resp.headers.get("Location") or redirect_resp.headers.get("location")
    if not loc:
        return stream_url, None

    loc_host = urlparse(loc).hostname
    if not _is_allowed_redirect_host(loc_host):
        logger.warning(
            "Rejecting SoundCloud redirect to disallowed host %r for track %s",
            loc_host,
            track_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud redirect target not in allowlist",
        )
    return loc, _extract_expires_from_url(loc)


async def _get_inflight_lock(track_id: int) -> asyncio.Lock:
    """Return the per-track lock, creating it on first use."""
    async with _inflight_locks_guard:
        lock = _inflight_locks.get(track_id)
        if lock is None:
            lock = asyncio.Lock()
            _inflight_locks[track_id] = lock
        return lock


@router.get("/tracks/{track_id}/stream", response_model=StreamUrlResponse)
async def get_track_stream(track_id: int, force_refresh: bool = False) -> StreamUrlResponse:
    """Return a signed HLS playlist URL for the given SoundCloud track.

    The result is cached in-memory and reused while still valid. Expired
    entries are transparently refetched.

    Parameters
    ----------
    track_id : int
        SoundCloud track id.
    force_refresh : bool, optional
        When true, evict any cached entry and fetch a fresh URL from
        SoundCloud. Clients should set this after receiving a 403 on a
        cached URL so the server does not hand them the same stale entry.

    Returns
    -------
    StreamUrlResponse
        ``url`` is the ``.m3u8`` playlist URL; ``expires_at`` is an ISO-8601
        UTC timestamp after which the client should refetch.
    """
    now = time.time()

    async with _cache_lock:
        if force_refresh:
            _cache.pop(track_id, None)
        entry = _cache.get(track_id)
        # Treat anything expiring in <60s as stale so clients don't race the expiry.
        if entry and entry.expires_at - now > 60:
            expires_dt = datetime.fromtimestamp(entry.expires_at, tz=UTC)
            return StreamUrlResponse(url=entry.url, expires_at=expires_dt.isoformat())

    # Per-track lock: collapse concurrent misses into a single upstream fetch.
    inflight = await _get_inflight_lock(track_id)
    async with inflight:
        # Re-check cache under the per-track lock — a sibling coroutine may
        # have populated it while we were waiting.
        async with _cache_lock:
            entry = _cache.get(track_id)
            if entry and entry.expires_at - time.time() > 60:
                expires_dt = datetime.fromtimestamp(entry.expires_at, tz=UTC)
                return StreamUrlResponse(url=entry.url, expires_at=expires_dt.isoformat())

        url, expires_at = await _fetch_stream_url(track_id)
        capped_expires = min(expires_at, time.time() + _DEFAULT_TTL_SECONDS)
        async with _cache_lock:
            _cache[track_id] = _CacheEntry(url=url, expires_at=capped_expires)

    expires_dt = datetime.fromtimestamp(capped_expires, tz=UTC)
    return StreamUrlResponse(url=url, expires_at=expires_dt.isoformat())


def _reset_cache_for_tests() -> None:
    """Clear the in-memory cache. Intended for tests only."""
    _cache.clear()
    _inflight_locks.clear()
    sc_auth_cache.reset_cache()
