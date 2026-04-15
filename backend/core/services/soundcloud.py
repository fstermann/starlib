"""
SoundCloud Service - API interactions for track search and metadata.

This module wraps the SoundCloud API client with domain-specific operations.
No UI framework dependencies.
"""

import logging
from typing import Any

import httpx

from soundcloud_tools.client import Client
from soundcloud_tools.handler.track import TrackInfo
from soundcloud_tools.models import Track

logger = logging.getLogger(__name__)

_SC_API_BASE = "https://api.soundcloud.com"


def _summarize_api_track(t: dict[str, Any]) -> dict[str, Any]:
    """Project an api.soundcloud.com track dict down to the fields we care about."""
    pm = t.get("publisher_metadata") or {}
    user = t.get("user") or {}
    artist = pm.get("artist") or user.get("username")
    artwork = t.get("artwork_url")
    if artwork:
        artwork = artwork.replace("-large.", "-t500x500.")
    release_date = t.get("release_date") or t.get("created_at") or ""
    return {
        "id": t.get("id"),
        "title": t.get("title"),
        "artist": artist,
        "genre": t.get("genre") or None,
        "release_date": release_date[:10] or None,
        "permalink_url": t.get("permalink_url"),
        "artwork_url": artwork,
    }


async def search_tracks_with_token(access_token: str, query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Search tracks via ``api.soundcloud.com`` with the user's OAuth token.

    Matches the frontend pattern: ``GET /tracks?q=...&limit=...`` with
    ``Authorization: OAuth <token>``. Returns summarized track dicts.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{_SC_API_BASE}/tracks",
            params={"q": query, "limit": limit},
            headers={"Authorization": f"OAuth {access_token}"},
        )
        resp.raise_for_status()
        data = resp.json()
    if not isinstance(data, list):
        return []
    return [_summarize_api_track(t) for t in data]


async def search_tracks(query: str, client: Client | None = None) -> list[Track]:
    """
    Search for tracks on SoundCloud.

    Parameters
    ----------
    query : str
        Search query
    client : Client, optional
        SoundCloud API client. If None, creates default client.

    Returns
    -------
    list[Track]
        List of matching tracks
    """
    if client is None:
        client = Client()

    result = await client.search(q=query)

    if not result or not result.collection:
        return []

    # Filter for tracks only
    tracks = [item for item in result.collection if item.kind == "track"]
    return tracks


async def get_track_by_url(url: str, client: Client | None = None) -> Track | None:
    """
    Get a track by its SoundCloud URL.

    Parameters
    ----------
    url : str
        SoundCloud track URL
    client : Client, optional
        SoundCloud API client. If None, creates default client.

    Returns
    -------
    Track | None
        Track object or None if not found
    """
    if client is None:
        client = Client()

    # Extract track ID from URL
    track_id = await client.get_track_id(url=url)
    if not track_id:
        return None

    # Fetch track by ID
    track = await client.get_track(track_id=track_id)
    return track


async def get_track_by_id(track_id: int, client: Client | None = None) -> Track | None:
    """
    Get a track by its SoundCloud ID.

    Parameters
    ----------
    track_id : int
        SoundCloud track ID
    client : Client, optional
        SoundCloud API client. If None, creates default client.

    Returns
    -------
    Track | None
        Track object or None if not found
    """
    if client is None:
        client = Client()

    track = await client.get_track(track_id=track_id)
    return track


def convert_sc_track_to_track_info(track: Track) -> TrackInfo:
    """
    Convert a SoundCloud Track to TrackInfo.

    This uses the existing TrackInfo.from_sc_track() method.

    Parameters
    ----------
    track : Track
        SoundCloud track object

    Returns
    -------
    TrackInfo
        Track information suitable for local metadata
    """
    return TrackInfo.from_sc_track(track)


async def search_and_convert_first(query: str, client: Client | None = None) -> TrackInfo | None:
    """
    Search SoundCloud and convert first result to TrackInfo.

    Convenience function for common workflow.

    Parameters
    ----------
    query : str
        Search query
    client : Client, optional
        SoundCloud API client

    Returns
    -------
    TrackInfo | None
        Track info for first result, or None if no results
    """
    tracks = await search_tracks(query, client)
    if not tracks:
        return None

    return convert_sc_track_to_track_info(tracks[0])


async def get_track_info_by_url(url: str, client: Client | None = None) -> TrackInfo | None:
    """
    Get TrackInfo from a SoundCloud URL.

    Parameters
    ----------
    url : str
        SoundCloud track URL
    client : Client, optional
        SoundCloud API client

    Returns
    -------
    TrackInfo | None
        Track info or None if not found
    """
    track = await get_track_by_url(url, client)
    if not track:
        return None

    return convert_sc_track_to_track_info(track)


def extract_metadata_from_sc_track(track: Track) -> dict:
    """
    Extract key metadata fields from a SoundCloud track.

    Returns a dictionary suitable for UI display or API response.

    Parameters
    ----------
    track : Track
        SoundCloud track object

    Returns
    -------
    dict
        Metadata dictionary with keys:
        - title, artist, genre, release_date, artwork_url
        - permalink_url, duration, playback_count, user info
    """
    return {
        "title": track.title,
        "artist": track.publisher_metadata.artist if track.publisher_metadata else track.user.username,
        "genre": track.genre or "",
        "release_date": track.display_date.date() if track.display_date else None,
        "artwork_url": track.hq_artwork_url or track.user.hq_avatar_url,
        "permalink_url": track.permalink_url,
        "duration_ms": track.duration,
        "playback_count": track.playback_count,
        "user": {
            "username": track.user.username,
            "permalink_url": track.user.permalink_url,
        },
    }
