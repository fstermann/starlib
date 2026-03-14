import logging
from collections import Counter
from datetime import datetime, timezone
from typing import Literal

import devtools

from soundcloud_tools.client import Client
from soundcloud_tools.models.artist_shortcut import Story, StoryType
from soundcloud_tools.models.comment import Comment
from soundcloud_tools.models.playlist import PlaylistCreate
from soundcloud_tools.models.request import PlaylistCreateRequest
from soundcloud_tools.models.stream import Stream, StreamItem, StreamItemType
from soundcloud_tools.models.track import Track, Tracks
from soundcloud_tools.settings import get_settings
from soundcloud_tools.utils import (
    Weekday,
    get_scheduled_time,
    get_unique_track_ids,
    get_week_of_month,
    sort_tracks_by_follower_count,
    sort_tracks_by_playcount,
)

logger = logging.getLogger(__name__)


Items = StreamItemType | Literal["comment"]


def get_configured_artist_usernames() -> set[str]:
    """
    Get the set of configured artist permalinks from settings.

    Returns
    -------
    set[str]
        Set of lowercase artist permalinks
    """
    settings = get_settings()
    if not settings.weekly_archive_artists:
        return set()

    permalinks = [p.strip().lower() for p in settings.weekly_archive_artists.split(",") if p.strip()]
    return set(permalinks)


def filter_by_configured_artists(items: list[Track]) -> list[Track]:
    """
    Filter stream items or comments by configured artist permalinks.

    Parameters
    ----------
    items : list[Track]
        Items to filter

    Returns
    -------
    list[Track]
        Filtered items from configured artists only
    """
    configured_artists = get_configured_artist_usernames()

    if not configured_artists:
        logger.info("No artist filter configured, returning all items")
        return items

    filtered = [item for item in items if item.user.permalink.lower() in configured_artists]
    logger.info(
        f"Filtered from {len(items)} to {len(filtered)} items based on {len(configured_artists)} configured artists"
    )
    return filtered


async def get_collections(
    client: Client, user_id: int, start: datetime, end: datetime, exclude_own: bool = True
) -> list[StreamItem | Comment]:
    reposts = await get_reposts(client, user_id, start, end, exclude_own)
    comments = await get_comments(client, user_id, start, end, exclude_own)
    return reposts + comments


async def get_stories(client: Client, start: datetime, end: datetime) -> list[Story]:
    artist_shortcuts = await client.get_artist_shortcuts()
    all_stories = []
    for artist_shortcut in artist_shortcuts.collection:
        logger.info(f"Fetching stories for {artist_shortcut.user.username}")
        response = await client.get_artist_shortcut_stories(user_urn=artist_shortcut.user.urn)
        logger.info(f"Found {len(response.stories)} stories for {artist_shortcut.user.username}")
        stories = [s for s in response.stories if start < s.created_at < end]
        all_stories += stories
    return all_stories


async def get_all_user_likes(client: Client, user_id: int) -> list[Track]:
    limit = 200
    offset: str | None = None
    all_tracks = []
    while True:
        response: Tracks = await client.get_user_likes(user_id=user_id, limit=limit, offset=offset)
        tracks = response.collection  # API returns Tracks collection directly
        all_tracks += tracks
        logger.info(f"Found {len(tracks)} liked tracks ({offset = }, total = {len(all_tracks)})")
        if not tracks:
            break
        offset = client.get_next_offset(response.next_href)
    return all_tracks


async def get_reposts(
    client: Client, user_id: int, start: datetime, end: datetime, exclude_own: bool = True
) -> list[StreamItem]:
    limit = 200
    offset: int = 0
    user_urn = f"soundcloud:users:{user_id}"
    n_zero = 0
    all_reposts: list[StreamItem] = []
    while True:
        response: Stream = await client.get_stream(user_urn=user_urn, limit=limit, offset=offset)
        reposts = [
            c
            for c in response.collection
            if start < c.created_at < end and (c.user.id != user_id if exclude_own else True)
        ]
        logger.info(f"Found {len(reposts)} valid reposts ({offset = }, total = {len(all_reposts)})")
        all_reposts += reposts
        if not reposts and all_reposts:
            break
        if not reposts:
            n_zero += 1
        if n_zero > 10:
            break
        offset += limit
    return all_reposts


async def get_comments(
    client: Client, user_id: int, start: datetime, end: datetime, exclude_own: bool = True
) -> list[Comment]:
    all_comments: list[Comment] = []
    followings = await client.get_user_followings_ids(user_id=user_id)
    for user_id in followings.collection:
        limit = 200
        offset: str | None = None
        while True:
            response: Stream = await client.get_user_comments(user_id=user_id, limit=limit, offset=offset)
            comments = [
                c
                for c in response.collection
                if start < c.created_at < end and (c.user.id != user_id if exclude_own else True)
            ]
            logger.info(f"Found {len(comments)} valid comments ({offset = }, total = {len(all_comments)})")
            all_comments += comments
            if not comments:
                break
            offset = client.get_next_offset(response.next_href)
    return all_comments


async def get_recent_weekly_track_ids(client: Client, user_id: int) -> set[int]:
    playlists = await client.get_user_playlists(user_id=user_id, limit=50)
    return {
        track.id
        for playlist in playlists.collection
        for track in playlist.tracks
        if "weekly favorites" in playlist.title.lower()
    }


def get_tracks_from_collections(collections: list[StreamItem | Comment], types: list[Items]) -> list[Track]:
    tracks: list[Track] = []
    for c in collections:
        if c.type not in types:
            continue
        if c.type.startswith("playlist"):
            tracks += c.playlist.tracks
        if c.type.startswith("track"):
            tracks.append(c.track)
        if c.type.startswith("comment"):
            tracks.append(c.track)
    return tracks


def get_track_ids_from_stories(stories: list[Story], types: list[StoryType]) -> set[int]:
    track_ids = set()
    for c in stories:
        if c.type not in types:
            continue
        if c.type.startswith("playlist"):
            track_ids |= {t.id for t in c.playlist.tracks}
        if c.type.startswith("track"):
            track_ids.add(c.snippeted_track.id)
    return track_ids


async def get_tracks_ids_in_timespan(
    client: Client, user_id: int, start: datetime, end: datetime, types: list[Items]
) -> list[Track]:
    tracks = []
    if "track" in types or "track-repost" in types:
        reposts = await get_reposts(client, user_id=user_id, start=start, end=end, exclude_own=True)
        tracks += get_tracks_from_collections(reposts, types=types)
    if "comment" in types:
        collections = await get_comments(client, user_id, start=start, end=end, exclude_own=True)
        tracks += get_tracks_from_collections(collections, types=types)
    tracks = filter_by_configured_artists(tracks)
    logger.info(f"Found {len(tracks)} tracks")
    return tracks


def filter_tracks_for_duration(tracks: list[Track], max_duration: int) -> list[Track]:
    ftracks = [track for track in tracks if getattr(track, "duration_s", 0) < max_duration]
    logger.info(f"Filtered to {len(ftracks)} tracks with duration < {max_duration}")
    return ftracks


def filter_tracks_for_date(tracks: list[Track], start: datetime | None, end: datetime | None) -> list[Track]:
    start = start or datetime.min.replace(tzinfo=timezone.utc)
    end = end or datetime.max.replace(tzinfo=timezone.utc)
    ftracks = [track for track in tracks if start < track.created_at < end]
    logger.info(f"Filtered to {len(ftracks)} tracks with date between {start} and {end}")
    return ftracks


async def filter_tracks_for_seen(client: Client, tracks: list[Track], user_id: int) -> list[Track]:
    seen_track_ids = await get_recent_weekly_track_ids(client=client, user_id=user_id)
    logger.info(f"Found {len(seen_track_ids)} seen tracks")
    ftracks = [track for track in tracks if track.id not in seen_track_ids]
    logger.info(f"Filtered to {len(ftracks)} unseen tracks")
    return ftracks


async def filter_tracks_for_liked(client: Client, tracks: list[Track], user_id: int) -> list[Track]:
    logger.info("Removing likes tracks")
    liked_tracks = await get_all_user_likes(client, user_id=user_id)
    liked_track_ids = {track.id for track in liked_tracks}
    ftracks = [track for track in tracks if track.id not in liked_track_ids]
    logger.info(f"Filtered to {len(ftracks)} tracks after removing liked tracks")
    return ftracks


def get_ordered_track_ids(tracks: list[Track]) -> list[int]:
    track_ids = [track.id for track in tracks]
    return [track_id for track_id, _ in Counter(track_ids).most_common()]


async def create_weekly_favorite_playlist(
    client: Client,
    user_id: int,
    types: list[Items],
    week: int = 0,
    exclude_liked: bool = False,
    half: Literal["first", "second"] | None = None,
    max_duration: int = 600,  # 10 minutes
    release_type: Literal["new", "old"] | None = None,
    dry_run: bool = False,
):
    logger.info(f"Creating weekly favorite playlist for {week = } and {types = }")
    start = get_scheduled_time(Weekday.SUNDAY, weeks=week - 1)
    end = get_scheduled_time(Weekday.SUNDAY, weeks=week)
    month, week_of_month = end.strftime("%b"), get_week_of_month(end)
    match half:
        case "first":
            end -= (end - start) / 2
        case "second":
            start += (end - start) / 2

    logger.info(f"Collecting favorites for {start.date()} - {end.date()}")

    # Filter tracks
    tracks = await get_tracks_ids_in_timespan(client, user_id=user_id, start=start, end=end, types=types)
    tracks = filter_tracks_for_duration(tracks=tracks, max_duration=max_duration)
    tracks = await filter_tracks_for_seen(client=client, tracks=tracks, user_id=user_id)
    if exclude_liked:
        tracks = await filter_tracks_for_liked(client=client, tracks=tracks, user_id=user_id)
    logger.info(f"Found {len(tracks)} tracks after filtering")

    # Get tracks with full info
    tracks = await client.get_all_tracks(track_ids=get_unique_track_ids(tracks))
    match release_type:
        case "new":
            tracks = filter_tracks_for_date(tracks=tracks, start=start, end=end)
            tracks = sort_tracks_by_follower_count(tracks=tracks)
        case "old":
            tracks = filter_tracks_for_date(tracks=tracks, start=None, end=start)
            tracks = sort_tracks_by_playcount(tracks=tracks)
        case _:
            tracks = sort_tracks_by_playcount(tracks=tracks)

    track_ids = get_unique_track_ids(tracks)
    logger.info(f"Found {len(track_ids)} new unique tracks")

    # Create playlist from track_ids
    week_prefix = f"{half.title()} half of " if half else " "
    week_suffix = "/1" if half == "first" else "/2" if half == "second" else ""
    playlist = PlaylistCreateRequest(
        playlist=PlaylistCreate(
            title=(
                f"{release_type.title() + ' ' if release_type else ''}"
                f"Weekly Favorites {month.upper()}/{week_of_month}{week_suffix}"
            ),
            description=(
                "Autogenerated set of liked and reposted tracks from my favorite artists.\n"
                f"{week_prefix} Week {week_of_month} of {month} "
                f"({start.date()} - {end.date()}, CW {start.isocalendar().week})"
            ),
            tracks=list(track_ids),
            sharing="private",
            tag_list=f"soundcloud-archive,weekly-favorites,{month.upper()}/{week_of_month},CW{start.isocalendar().week}",
        )
    )
    request = devtools.pformat(playlist.model_dump(exclude={"playlist": {"tracks"}}))
    logger.info(f"Creating playlist {request} with {len(playlist.playlist.tracks)} tracks")
    if dry_run:
        logger.info("Dry run, not creating playlist")
        return track_ids
    # Create playlist
    await client.post_playlist(data=playlist)
    return track_ids
