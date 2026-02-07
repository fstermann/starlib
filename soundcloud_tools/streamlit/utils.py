import urllib.parse
from collections import Counter
from typing import Callable

import pandas as pd
import streamlit as st
from streamlit import session_state as sst
from tabulate import tabulate

from soundcloud_tools.models import Track
from soundcloud_tools.models.repost import Repost
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
