import asyncio
import base64
import logging
import re
from datetime import date, datetime
from typing import Callable

import devtools
import requests
import streamlit as st
from streamlit import session_state as sst

from soundcloud_tools.models import User
from soundcloud_tools.models.playlist import Playlist, PlaylistUpdateImageRequest
from soundcloud_tools.models.repost import Repost
from soundcloud_tools.models.track import Track
from soundcloud_tools.settings import get_settings
from soundcloud_tools.streamlit.client import Client, get_client
from soundcloud_tools.streamlit.utils import create_soundcloud_playlist, display_collection_tracks

logger = logging.getLogger(__name__)


@st.cache_data
def search_users(user_query: str) -> list[User]:
    client = get_client()
    result = asyncio.run(client.search_users(q=user_query))
    return [user for user in result.collection if user.kind == "user"]


@st.cache_data(show_spinner="Fetching tracks", hash_funcs={"builtins.method": str})
def fetch_collection_response(endpoint: Callable, limit: int = 100, **kwargs) -> list[Repost] | list[Track]:
    offset: int | str | None = None  # Start with None, not 0
    items = []
    while True:
        try:
            # Only pass offset if it's not None
            params = {**kwargs, "limit": limit}
            if offset is not None:
                params["offset"] = offset
            response = asyncio.run(endpoint(**params))
            if response is None:
                logger.warning("Endpoint returned None response")
                break
            items.extend(response.collection)
            if not response.next_href:
                break
            offset = Client.get_next_offset(response.next_href)
            if offset is None:
                break
            logger.info(f"Using next offset: {offset}")
        except Exception as e:
            logger.error(f"Error fetching collection: {e}")
            break

    return items


def get_type(repost):
    return getattr(repost, "kind", None) or getattr(repost, "type", None)


def get_info(repost):
    if hasattr(repost, "track"):
        return {
            "artist": repost.track.artist,
            "title": repost.track.title,
            "created_at": repost.created_at,
            "type": get_type(repost),
        }
    else:
        return {
            "artist": repost.playlist.user.username,
            "title": repost.playlist.title,
            "created_at": repost.created_at,
            "type": repost.type,
        }


def display_user(user: User):
    c1, c2 = st.columns(2)
    with c2:
        st.image(user.avatar_url)
    with c1:
        st.write(f"#### [{user.username}]({user.permalink_url})")
        st.caption(
            f"{user.full_name}  \nCountry: {user.city}, {user.country_code}  \nFollowers: {user.followers_count}"
        )


def create_playlist(likes: list[Track], reposts: list[Repost], artist: str, filters: dict) -> Playlist | None:
    items = sorted(likes + reposts, key=lambda x: parse_created_at(x.created_at), reverse=True)
    track_ids: list[int] = []
    for item in items:
        track_id = item.id if isinstance(item, Track) else item.track.id
        if track_id not in track_ids:
            track_ids.append(track_id)

    return create_soundcloud_playlist(
        title=f"{artist} | Likes & Reposts | {filters['start_date']} - {filters['end_date']}",
        description=f"Likes and reposts of {artist} from {filters['start_date']} - {filters['end_date']}",
        track_ids=track_ids,
        tag_list="likes,reposts,soundcloud-tools",
    )


def main():
    st.header(":material/favorite: Like Explorer")
    st.write(
        "Explore likes and reposts of your favorite SoundCloud artists, and create custom playlists with the tracks."
    )

    # Show success message if we just completed OAuth
    if sst.get("oauth_just_completed"):
        st.success("✓ Authorization successful! You can now create playlists.")
        del sst.oauth_just_completed

    # Show authentication status
    client = get_client()
    auth_status = client.get_auth_status()

    # Check if using user tokens (has refresh token) vs client credentials
    has_write_access = bool(client._refresh_token)

    if has_write_access:
        st.success("✓ Authenticated with user account - Playlist creation enabled")
    else:
        with st.expander("⚠️ Read-only mode - Playlist creation disabled", expanded=False):
            st.warning(
                "Currently using **Client Credentials** (read-only access). "
                "To create playlists, set up user OAuth tokens:\n\n"
                "1. Run: `poetry run python get_user_tokens.py`\n"
                "2. Add tokens to your `.env` file:\n"
                "   ```\n"
                "   SOUNDCLOUD_OAUTH_TOKEN=your_access_token\n"
                "   SOUNDCLOUD_REFRESH_TOKEN=your_refresh_token\n"
                "   ```\n"
                "3. Restart the Streamlit app\n\n"
                "See the [API Guide](https://developers.soundcloud.com/docs/api/guide#authentication) for details."
            )

    st.divider()

    sst.setdefault("user_likes", [])
    sst.setdefault("user_reposts", [])
    sst.setdefault("own_likes", [])
    sst.setdefault("fetched_user", {})

    with st.sidebar:
        st.text_input("Search for a User", key="user_query")
        if not sst.user_query:
            st.stop()

        if not (users := search_users(sst.user_query)):
            st.error("No users found.")
            st.stop()

        user = st.radio("Select a User", users, format_func=lambda user: user.username, key="selected_user")
        display_user(user)

        collect = st.button(":material/wrist: Collect")
        st.caption(
            "This fetches all likes and reposts of the user to use for filtering, interacting and playlist creation. "
            "This may take a while."
        )
    if collect:
        user_urn = f"soundcloud:users:{user.id}"
        own_user_urn = f"soundcloud:users:{get_settings().user_id}"
        sst.user_likes = fetch_collection_response(endpoint=client.get_user_likes, user_urn=user_urn, limit=200)
        # Note: User reposts endpoint not available in public API
        # sst.user_reposts = fetch_collection_response(endpoint=client.get_user_reposts, user_urn=user_urn, limit=200)
        sst.user_reposts = []  # Reposts not available via public API
        sst.own_likes = fetch_collection_response(endpoint=client.get_user_likes, user_urn=own_user_urn, limit=200)
        sst.fetched_user[user.id] = True

    if not sst.fetched_user.get(user.id):
        st.warning("No likes or reposts fetched yet for this user.")
        st.stop()

    with st.container(border=True):
        st.write("#### :material/filter_alt: Filter")
        filters = get_filters()
    filtered_likes = filter_collection(sst.user_likes, **filters)
    filtered_reposts = filter_collection(sst.user_reposts, **filters)

    st.write("#### :material/favorite: Likes")
    st.caption("An embedded player will show up when you select a track.")
    display_collection_tracks(filtered_likes, "Likes")
    st.write("#### :material/swap_horiz: Reposts")
    display_collection_tracks(filtered_reposts, "Reposts")

    if st.button(":material/add: Create Playlist"):
        # st.write(user.avatar_url)
        playlist = create_playlist(
            likes=filtered_likes, reposts=filtered_reposts, artist=user.username, filters=filters
        )
        # if playlist:
        #     update_playlist_image(user=user, playlist_id=playlist.id)


def update_playlist_image(user: User, playlist_id: int):
    if not user.hq_avatar_url:
        st.warning("No avatar image found for the user.")
        return
    data = requests.get(user.hq_avatar_url).content
    image_data = base64.b64encode(data).decode("utf-8")
    playlist_urn = f"soundcloud:playlists:{playlist_id}"
    asyncio.run(
        get_client().update_playlist_image(
            playlist_urn=playlist_urn, data=PlaylistUpdateImageRequest(image_data=image_data)
        )
    )
    st.toast("Playlist image updated.", icon="🎉")


def get_filters():
    c1, c2, c3, c4, c5 = st.columns(5)
    search = c1.text_input("Search")
    start_date = c2.date_input("Start Date", value=None) or date.min
    end_date = c3.date_input("End Date", value=None) or date.today()
    max_length = c4.number_input("Max Length (mins)", value=12, step=1)
    exclude_own = c5.checkbox("Exclude Own Liked Tracks", value=True)
    # Likes endpoint returns Track objects directly now
    own_likes = [like.id for like in sst.own_likes if isinstance(like, Track)] if exclude_own else []
    c5.write(f"Own Likes: {len(own_likes)}")

    filters = {
        "start_date": start_date,
        "end_date": end_date,
        "max_length": max_length,
        "own_likes": own_likes,
        "search": search,
    }

    return filters


def parse_created_at(created_at_str: str) -> datetime:
    """Parse created_at string which can be in multiple formats"""
    if isinstance(created_at_str, datetime):
        return created_at_str

    # Try ISO 8601 format first (e.g., '2025-09-23T10:10:32Z')
    try:
        return datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        pass

    # Try SoundCloud format (e.g., '2025/09/23 10:10:32 +0000')
    try:
        return datetime.strptime(created_at_str, "%Y/%m/%d %H:%M:%S %z")
    except (ValueError, AttributeError):
        pass

    # Fallback: return epoch if parsing fails
    logger.warning(f"Could not parse created_at: {created_at_str}")
    return datetime.fromtimestamp(0)


def filter_collection(
    collection: list[Track] | list[Repost],
    start_date: date,
    end_date: date,
    max_length: int,
    own_likes: list[int],
    search: str,
):
    items = []
    for item in collection:
        # Handle Track objects (from likes endpoint) vs Repost objects
        if isinstance(item, Track):
            track = item
            # Parse created_at string to datetime
            created_at = parse_created_at(item.created_at)
        elif hasattr(item, "track"):
            track = item.track
            # For Repost objects, created_at might be datetime or string
            created_at = parse_created_at(item.created_at)
        else:
            continue

        # Apply filters
        if (
            start_date <= created_at.date() <= end_date
            and track.duration / 60_000 < max_length
            and (not own_likes or track.id not in own_likes)
            and (
                not search or any(re.search(search, attr, flags=re.IGNORECASE) for attr in (track.title, track.artist))
            )
        ):
            items.append(item)

    return sorted(items, key=lambda x: x.created_at if hasattr(x, "created_at") else x.created_at, reverse=True)


if __name__ == "__main__":
    main()
