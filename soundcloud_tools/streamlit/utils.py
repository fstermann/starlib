import asyncio
import urllib.parse
from collections import Counter
from collections.abc import Callable

import pandas as pd
import requests
import streamlit as st
from streamlit import session_state as sst
from tabulate import tabulate

from soundcloud_tools.models import Track
from soundcloud_tools.models.playlist import Playlist, PlaylistCreate
from soundcloud_tools.models.repost import Repost
from soundcloud_tools.models.request import PlaylistCreateRequest
from soundcloud_tools.models.stream import StreamItem


def apply_to_sst(func: Callable, key: str) -> Callable:
    def inner():
        sst[key] = func(sst.get(key))

    return inner


def table(data):
    _css = "border: none; vertical-align: top"
    tbl = (
        tabulate(data, tablefmt="unsafehtml")
        .replace('<td style="', f'<td style="{_css} ')
        .replace("<td>", f'<td style="{_css}">')
        .replace('<tr style="', f'<tr style="{_css} ')
        .replace("<tr>", f'<tr style="{_css}">')
    )
    st.write(tbl, unsafe_allow_html=True)


def generate_css(**kwargs):
    return ";".join(f"{k.replace('_', '-')}:{v}" for k, v in kwargs.items())


def render_embedded_track(track: Track, height: int = 300):
    options = {
        "url": f"https://api.soundcloud.com/tracks/{track.id}",
        "color": "#ff5500",
        "auto_play": "false",
        "hide_related": "false",
        "show_comments": "true",
        "show_user": "true",
        "show_reposts": "false",
        "show_teaser": "true",
        "visual": "true",
    }
    src_url = f"https://w.soundcloud.com/player/?{urllib.parse.urlencode(options)}"
    div_css = generate_css(
        font_size="10px",
        color="#cccccc",
        line_break="anywhere",
        word_break="normal",
        overflow="hidden",
        white_space="nowrap",
        text_overflow="ellipsis",
        font_family="Interstate,Lucida Grande,Lucida Sans Unicode,Lucida Sans,Garuda,Verdana,Tahoma,sans-serif",
        font_weight="100",
    )
    link_css = generate_css(
        color="#cccccc",
        text_decoration="none",
    )

    st.write(
        f"""\
<iframe width="100%" height="{height}" scrolling="no" frameborder="no" allow="autoplay" src="{src_url}"></iframe>
<div style="{div_css}">
<a href="{track.user.permalink_url}" title="{track.user.full_name}" target="_blank" style="{link_css}">\
{track.user.full_name}</a>
 ·
<a href="{track.permalink_url}" title="{track.title}" target="_blank" style="{link_css}">{track.title}</a>
</div>""",
        unsafe_allow_html=True,
    )


def reset_track_info_sst():
    for key in sst:
        if key.startswith("ti_"):
            try:
                if key == "ti_comment_on_sc":
                    sst[key] = True
                else:
                    sst[key] = type(sst[key])()
            except (TypeError, ValueError):
                sst[key] = None


def wrap_and_reset_state(func: Callable):
    def wrapper():
        func()
        reset_track_info_sst()

    return wrapper


def create_soundcloud_playlist(
    title: str,
    description: str,
    track_ids: list[int],
    tag_list: str = "",
    sharing: str = "private",
) -> Playlist | None:
    """Create a SoundCloud playlist from a list of track IDs.

    Requires write access (OAuth refresh token). Returns None on failure.
    """
    from soundcloud_tools.streamlit.client import get_client

    client = get_client()
    if not client._refresh_token:
        st.error("⚠️ Write access required to create playlists. Set up user OAuth tokens (see Authentication page).")
        return None

    # Deduplicate while preserving order
    seen: set[int] = set()
    unique_ids = [tid for tid in track_ids if not (tid in seen or seen.add(tid))]

    playlist_req = PlaylistCreateRequest(
        playlist=PlaylistCreate(
            title=title,
            description=description,
            tracks=unique_ids,
            sharing=sharing,
            tag_list=tag_list,
        )
    )
    try:
        created = asyncio.run(client.post_playlist(data=playlist_req))
        st.toast(f"Playlist '{title}' created with {len(unique_ids)} tracks.", icon="🎉")
        return created
    except requests.HTTPError as e:
        st.error(f"Failed to create playlist: {e.response.status_code} - {e.response.text}")
        return None


def display_collection_tracks(collection: list[StreamItem] | list[Track] | list[Repost], caption: str):
    data = pd.DataFrame(
        [
            getattr(item, "track", item).model_dump() | {"liked_at": getattr(item, "created_at", None)}  # type: ignore
            for item in collection
        ]
    )
    if data.empty:
        st.warning(f"No {caption} found.")
        return
    cols = data.columns.to_list()
    cols.remove("title")
    cols.remove("liked_at")
    data = data[["title", "liked_at", *cols]]

    c1, c2 = st.columns([1, 1])
    selection = c1.dataframe(
        data, use_container_width=True, on_select="rerun", selection_mode="single-row", key=f"df_{caption}"
    )
    st.caption(f"Total {caption}: {len(collection)}")
    with c2.popover("Info", use_container_width=True):
        genres = sorted(Counter(data["genre"]).items(), key=lambda x: x[1], reverse=True)
        st.table(genres)

    if index := selection["selection"]["rows"]:
        selected = data.iloc[index[0]]
        track = Track(**selected.to_dict())
        with c2:
            render_embedded_track(track)
