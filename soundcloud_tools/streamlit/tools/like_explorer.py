import asyncio
import base64
import logging
import re
from datetime import date
from typing import Callable

import devtools
import requests
import streamlit as st
from streamlit import session_state as sst

from soundcloud_tools.models import User
from soundcloud_tools.models.playlist import Playlist, PlaylistCreate, PlaylistUpdateImageRequest
from soundcloud_tools.models.repost import Repost
from soundcloud_tools.models.request import PlaylistCreateRequest
from soundcloud_tools.models.track import Track
from soundcloud_tools.settings import get_settings
from soundcloud_tools.streamlit.client import Client, get_client
from soundcloud_tools.streamlit.utils import display_collection_tracks

logger = logging.getLogger(__name__)


@st.cache_data
def search_users(user_query: str) -> list[User]:
    client = get_client()
    result = asyncio.run(client.search(q=user_query))
    return [user for user in result.collection if user.kind == "user"]


@st.cache_data(show_spinner="Fetching tracks", hash_funcs={"builtins.method": str})
def fetch_collection_response(endpoint: Callable, limit: int = 100, **kwargs) -> list[Repost] | list[Track]:
    offset: int | str | None = 0
    items = []
    while True:
        try:
            response = asyncio.run(endpoint(**kwargs, limit=limit, offset=offset))
            items.extend(response.collection)
            if not response.next_href:
                break
            offset = Client.get_next_offset(response.next_href)
            logger.info("Using next offset", offset)
        except Exception as e:
            logger.error(e)
            raise e

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


def create_playlist(likes: list[Track], reposts: list[Repost], artist: str, filters: dict) -> Playlist:
    # Keep liked/reposted order
    items = sorted(likes + reposts, key=lambda x: x.created_at, reverse=True)
    track_ids = []
    for item in items:
        if item.track.id not in track_ids:
            track_ids.append(item.track.id)

    playlist = PlaylistCreateRequest(
        playlist=PlaylistCreate(
            title=f"{artist} | Likes & Reposts | {filters['start_date']} - {filters['end_date']}",
            description=(f"Likes and reposts of {artist} from {filters['start_date']} - {filters['end_date']}"),
            tracks=list(track_ids),
            sharing="private",
            tag_list="likes,reposts,soundcloud-tools",
        )
    )
    request = devtools.pformat(playlist.model_dump(exclude={"playlist": {"tracks"}}))
    logger.info(f"Creating playlist {request} with {len(track_ids)} tracks")
    created_playlist = asyncio.run(get_client().post_playlist(data=playlist))
    st.toast(f"Playlist created for {artist} with {len(track_ids)} tracks.", icon="🎉")
    return created_playlist


def main():
    st.header(":material/favorite: Like Explorer")
    st.write(
        "Explore likes and reposts of your favorite SoundCloud artists, and create custom playlists with the tracks."
    )
    st.divider()

    client = get_client()
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
        sst.user_likes = fetch_collection_response(endpoint=client.get_user_likes, user_id=user.id, limit=200)
        sst.user_reposts = fetch_collection_response(endpoint=client.get_user_reposts, user_id=user.id, limit=200)
        sst.own_likes = fetch_collection_response(
            endpoint=client.get_user_likes, user_id=get_settings().user_id, limit=200
        )
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
        st.write(user.avatar_url)
        playlist = create_playlist(
            likes=filtered_likes, reposts=filtered_reposts, artist=user.username, filters=filters
        )
        update_playlist_image(user=user, playlist_id=playlist.id)


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
    own_likes = [like.track.id for like in sst.own_likes if hasattr(like, "track")] if exclude_own else []
    c5.write(f"Own Likes: {len(own_likes)}")

    filters = {
        "start_date": start_date,
        "end_date": end_date,
        "max_length": max_length,
        "own_likes": own_likes,
        "search": search,
    }

    return filters


def filter_collection(
    collection: list[Track] | list[Repost],
    start_date: date,
    end_date: date,
    max_length: int,
    own_likes: list[int],
    search: str,
):
    items = [
        item
        for item in collection
        if hasattr(item, "track")
        and start_date <= item.created_at.date() <= end_date
        and item.track.duration / 60_000 < max_length
        and (not own_likes or (own_likes and item.track.id not in own_likes))
        and (
            not search
            or (
                search
                and any(re.search(search, attr, flags=re.IGNORECASE) for attr in (item.track.title, item.track.artist))
            )
        )
    ]
    return sorted(items, key=lambda x: x.created_at, reverse=True)


if __name__ == "__main__":
    main()
