"""SoundCloud HLS stream URL endpoint.

Provides a signed, short-lived HLS playlist URL for a SoundCloud track,
fetched from the public SoundCloud API via OAuth Client Credentials.
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

import httpx
from fastapi import APIRouter, Header, HTTPException, Response, status

from backend.infra.soundcloud import client, token_cache
from backend.infra.soundcloud.oauth import OAuthManager  # re-exported for tests
from backend.infra.soundcloud.settings import get_settings  # re-exported for tests
from backend.schemas.soundcloud import (
    StreamUrlResponse,
    TrackBpmRequest,
    TrackBpmResponse,
    TrackPeaksResponse,
)

__all__ = ["OAuthManager", "get_settings", "router"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud", tags=["soundcloud"])

_PUBLIC_API_BASE = client.PUBLIC_API_BASE

# Default cache TTL (seconds). Signed CDN URLs live ~1 hour; refresh at 30 min.
_DEFAULT_TTL_SECONDS = 30 * 60

_HTTP_TIMEOUT_SECONDS: float = client.TIMEOUT_SECONDS

# Accepted range for a manual BPM correction — wide enough for any dance genre.
_BPM_MIN = 40.0
_BPM_MAX = 300.0

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
    the web-client `client_id`/`app_version` query params, because the public
    API drops the Authorization header and returns 401 when those are present.
    """
    return await client.get(url, token=token, follow_redirects=follow_redirects)


async def _public_api_token() -> str:
    """Acquire a Client-Credentials token usable against ``api.soundcloud.com``."""
    settings = get_settings()
    if not settings.has_oauth_credentials():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud OAuth credentials not configured",
        )
    try:
        return token_cache.get_cached_access_token(settings, OAuthManager)
    except Exception as exc:
        logger.exception("Failed to acquire SoundCloud OAuth token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud auth unavailable",
        ) from exc


async def _resolve_track_id(url: str) -> int | None:
    """Resolve a soundcloud.com URL to a numeric track id via the public API.

    Uses ``api.soundcloud.com/resolve`` rather than going through
    ``soundcloud_tools.Client`` (which targets ``api-v2`` and requires the
    web-session token). Returns ``None`` if the URL doesn't point at a
    track resource.
    """
    token = await _public_api_token()
    resolve_url = f"{_PUBLIC_API_BASE}/resolve"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(
                resolve_url,
                headers={
                    "Authorization": f"OAuth {token}",
                    "Accept": "application/json",
                },
                params={"url": url},
                follow_redirects=True,
            )
    except Exception as exc:  # pragma: no cover - network transport
        logger.exception("SoundCloud /resolve request failed for %s", url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud upstream error",
        ) from exc
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        logger.warning("SoundCloud /resolve returned %s for %s", response.status_code, url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud returned {response.status_code}",
        )
    data = response.json()
    if not isinstance(data, dict) or data.get("kind") != "track":
        return None
    track_id = data.get("id")
    return int(track_id) if isinstance(track_id, int) else None


async def _fetch_track_meta(track_id: int) -> dict | None:
    """Fetch ``/tracks/{id}`` from the public API. Returns the JSON dict or
    ``None`` on 404. Errors raise an HTTPException so the caller surfaces a
    consistent 502.
    """
    token = await _public_api_token()
    track_url = f"{_PUBLIC_API_BASE}/tracks/{track_id}"
    try:
        response = await _http_get(track_url, token=token, follow_redirects=True)
    except Exception as exc:  # pragma: no cover - network transport
        logger.exception("SoundCloud /tracks/%s request failed", track_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud upstream error",
        ) from exc
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        logger.warning("SoundCloud /tracks/%s returned %s", track_id, response.status_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud returned {response.status_code}",
        )
    data = response.json()
    return data if isinstance(data, dict) else None


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
        token = token_cache.get_cached_access_token(settings, OAuthManager)
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
        token_cache.reset_cache()
        try:
            token = token_cache.get_cached_access_token(settings, OAuthManager)
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


async def _resolve_track_audio_path(track_id: int):
    """Return the cached audio path for a track, fetching it if not yet cached."""
    from backend.infra.analyser import cache as audio_cache

    path = audio_cache.cached_set_path(track_id)
    if path is None:
        hls_url, _expires = await _fetch_stream_url(track_id)
        token = token_cache.get_cached_access_token(get_settings(), OAuthManager)
        path = await audio_cache.fetch_set_audio(track_id, hls_url=hls_url, auth_header=f"OAuth {token}")
    return path


@router.get("/tracks/{track_id}/peaks", response_model=TrackPeaksResponse)
async def get_track_peaks(track_id: int) -> TrackPeaksResponse:
    """Return high-resolution waveform peaks for a SoundCloud track.

    Downloads the track's audio (reusing the analyser set cache) and decodes
    it to a normalized amplitude envelope — far finer than SoundCloud's
    ``waveform_url``, which is too coarse for kick-level alignment. Results
    are cached on disk keyed by track id. A user BPM correction, if one
    exists, overrides the detected tempo in the returned ``bpm``.

    Parameters
    ----------
    track_id : int
        SoundCloud track id.

    Returns
    -------
    TrackPeaksResponse
        Normalized peaks in ``[0, 1]`` and the audio duration in seconds.
    """
    from backend.infra import cache as db_cache
    from backend.infra.analyser import peaks as peaks_infra

    path = await _resolve_track_audio_path(track_id)

    try:
        peaks, duration_s, detected_bpm = await peaks_infra.get_or_compute_peaks(path, track_id)
    except Exception as exc:
        logger.exception("Failed to compute peaks for track %s", track_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to decode track audio",
        ) from exc

    override = db_cache.get_sc_bpm_override(track_id)
    return TrackPeaksResponse(
        peaks=peaks,
        duration_s=duration_s,
        bpm=override if override is not None else detected_bpm,
        bpm_overridden=override is not None,
    )


@router.put("/tracks/{track_id}/bpm", response_model=TrackBpmResponse)
async def set_track_bpm(track_id: int, body: TrackBpmRequest) -> TrackBpmResponse:
    """Set a user BPM correction for a SoundCloud track's original tempo.

    Persisted independently of the peaks/detection caches so it survives a
    re-decode. The correction wins over detection wherever the original BPM
    is shown.
    """
    from backend.infra import cache as db_cache

    if not (_BPM_MIN <= body.bpm <= _BPM_MAX):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"BPM must be between {_BPM_MIN:g} and {_BPM_MAX:g}",
        )
    db_cache.upsert_sc_bpm_override(track_id, body.bpm, time.time())
    return TrackBpmResponse(bpm=body.bpm, bpm_overridden=True)


@router.delete("/tracks/{track_id}/bpm", response_model=TrackBpmResponse)
async def clear_track_bpm(track_id: int) -> TrackBpmResponse:
    """Remove the user BPM correction, reverting to the detected tempo."""
    from backend.infra import cache as db_cache
    from backend.infra.analyser import peaks as peaks_infra

    db_cache.delete_sc_bpm_override(track_id)
    # The detected tempo is already in the peaks cache; read it directly rather
    # than re-resolving the audio path (which can re-download an evicted set)
    # and re-decoding just to fetch a value we already have.
    cached, detected_bpm = peaks_infra.read_cached_bpm(track_id)
    if not cached:
        path = await _resolve_track_audio_path(track_id)
        try:
            _peaks, _duration_s, detected_bpm = await peaks_infra.get_or_compute_peaks(path, track_id)
        except Exception as exc:
            logger.exception("Failed to compute peaks for track %s", track_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to decode track audio",
            ) from exc
    return TrackBpmResponse(bpm=detected_bpm, bpm_overridden=False)


@router.post("/tracks/{track_id}/bpm/reanalyse", response_model=TrackBpmResponse)
async def reanalyse_track_bpm(track_id: int) -> TrackBpmResponse:
    """Re-run tempo detection for a track, bypassing caches and any correction.

    Detection is deterministic, so this returns the same value as before unless
    the cached result was stale or detection had previously failed.
    """
    from backend.infra import cache as db_cache
    from backend.infra.analyser import peaks as peaks_infra

    db_cache.delete_sc_bpm_override(track_id)
    path = await _resolve_track_audio_path(track_id)
    try:
        _peaks, _duration_s, detected_bpm = await peaks_infra.get_or_compute_peaks(path, track_id, force=True)
    except Exception as exc:
        logger.exception("Failed to reanalyse track %s", track_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to decode track audio",
        ) from exc
    return TrackBpmResponse(bpm=detected_bpm, bpm_overridden=False)


def _user_token_from_authorization(authorization: str | None) -> str:
    """Extract the user's SoundCloud access token from an Authorization header.

    Accepts both ``OAuth <token>`` (what the SC API expects) and
    ``Bearer <token>`` (the conventional frontend idiom). The browser can't
    call ``POST``/``DELETE /likes/tracks/...`` directly because SoundCloud
    doesn't expose those methods in its CORS policy — so this endpoint acts
    as a thin proxy that forwards the request with the user's own token.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )
    for prefix in ("OAuth ", "Bearer "):
        if authorization.startswith(prefix):
            return authorization[len(prefix) :].strip()
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authorization header must be 'OAuth <token>' or 'Bearer <token>'",
    )


async def _proxy_like(track_id: int, method: str, token: str) -> Response:
    """Forward a like/unlike call to the SoundCloud public API."""
    url = f"{_PUBLIC_API_BASE}/likes/tracks/soundcloud:tracks:{track_id}"
    try:
        resp = await client.request(method, url, token=token)
    except Exception as exc:
        logger.exception("SoundCloud like proxy transport error")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud upstream error",
        ) from exc

    if resp.status_code in (401, 403):
        raise HTTPException(
            status_code=resp.status_code,
            detail="SoundCloud rejected the user token",
        )
    if not resp.is_success:
        logger.warning(
            "SoundCloud %s /likes/tracks returned %s for track %s",
            method,
            resp.status_code,
            track_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud returned {resp.status_code}",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/tracks/{track_id}/like", status_code=status.HTTP_204_NO_CONTENT)
async def like_track(
    track_id: int,
    authorization: str | None = Header(default=None),
) -> Response:
    """Like a SoundCloud track on behalf of the authenticated user."""
    token = _user_token_from_authorization(authorization)
    return await _proxy_like(track_id, "POST", token)


@router.delete("/tracks/{track_id}/like", status_code=status.HTTP_204_NO_CONTENT)
async def unlike_track(
    track_id: int,
    authorization: str | None = Header(default=None),
) -> Response:
    """Unlike a SoundCloud track on behalf of the authenticated user."""
    token = _user_token_from_authorization(authorization)
    return await _proxy_like(track_id, "DELETE", token)


async def _proxy_playlist_delete(playlist_id: int, token: str) -> Response:
    """Forward a playlist delete to the SoundCloud public API."""
    url = f"{_PUBLIC_API_BASE}/playlists/soundcloud:playlists:{playlist_id}"
    try:
        resp = await client.request("DELETE", url, token=token)
    except Exception as exc:
        logger.exception("SoundCloud playlist delete proxy transport error")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud upstream error",
        ) from exc

    if resp.status_code in (401, 403):
        raise HTTPException(
            status_code=resp.status_code,
            detail="SoundCloud rejected the user token",
        )
    if not resp.is_success:
        logger.warning(
            "SoundCloud DELETE /playlists returned %s for playlist %s",
            resp.status_code,
            playlist_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud returned {resp.status_code}",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/playlists/{playlist_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_playlist(
    playlist_id: int,
    authorization: str | None = Header(default=None),
) -> Response:
    """Delete a SoundCloud playlist on behalf of the authenticated user.

    The browser can't call ``DELETE /playlists/...`` directly — SoundCloud
    doesn't expose that method in its CORS policy — so this endpoint forwards
    the request with the user's own token.
    """
    token = _user_token_from_authorization(authorization)
    return await _proxy_playlist_delete(playlist_id, token)


def _reset_cache_for_tests() -> None:
    """Clear the in-memory cache. Intended for tests only."""
    _cache.clear()
    _inflight_locks.clear()
    token_cache.reset_cache()
