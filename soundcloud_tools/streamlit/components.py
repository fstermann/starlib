import asyncio

import streamlit as st
from streamlit import session_state as sst

from soundcloud_tools.handler.track import Comment, Remix, TrackInfo
from soundcloud_tools.predict.base import Predictor
from soundcloud_tools.streamlit.client import get_client
from soundcloud_tools.streamlit.utils import apply_to_sst, render_embedded_track
from soundcloud_tools.utils.string import (
    changed_string,
    clean_artists,
    clean_title,
    get_raw_title,
    is_remix,
    remove_parenthesis,
    titelize,
)

ARTWORK_WIDTH = 100


def build_component_columns(n_buttons: int, left: float = 0.15, mid: float | tuple[float, ...] = 0.5):
    match mid:
        case float():
            mid_list = [mid]
        case tuple():
            mid_list = list(mid)

    cols = st.columns([left] + mid_list + [(1 - left - sum(mid_list)) / n_buttons] * n_buttons)
    caption_col = cols[0]
    field_cols = cols[1] if len(mid_list) == 1 else cols[1 : 1 + len(mid_list)]
    buttons = cols[1 + len(mid_list) :]
    return caption_col, field_cols, iter(buttons)


def build_title_from_remix(title: str):
    return f"{sst.ti_original_artist} - {get_raw_title(title)} ({sst.ti_remixer} {sst.ti_mix_name})"


def title_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None) -> str:
    caption_col, field_col, buttons = build_component_columns(6)
    sst.setdefault("ti_title", track_info.title)
    caption_col.write(f"__Title__{changed_string(track_info.title, sst.ti_title)}")
    next(buttons).button(
        ":material/cloud_download:",
        help="Copy Metadata from Soundcloud",
        on_click=sst.__setitem__,
        args=("ti_title", sc_track_info and sc_track_info.title),
        use_container_width=True,
        key="copy_title",
        disabled=sc_track_info is None,
    )
    next(buttons).button(
        ":material/cleaning_services:",
        help="Clean",
        key="clean_title",
        on_click=apply_to_sst(clean_title, "ti_title"),
        use_container_width=True,
    )
    next(buttons).button(
        ":material/arrow_upward:",
        help="Titelize",
        key="titelize_title",
        on_click=apply_to_sst(titelize, "ti_title"),
        use_container_width=True,
    )
    next(buttons).button(
        ":material/tune:",
        help="Build from Remix data",
        key="build_title",
        on_click=apply_to_sst(build_title_from_remix, "ti_title"),
        use_container_width=True,
    )
    next(buttons).button(
        ":material/data_array:",
        help="Remove `[]` parenthesis",
        key="remove_parenthesis_title",
        on_click=apply_to_sst(remove_parenthesis, "ti_title"),
        use_container_width=True,
    )
    next(buttons).button(
        ":material/content_cut:",
        help="Isolate Title",
        key="isolate_title",
        on_click=apply_to_sst(get_raw_title, "ti_title"),
        use_container_width=True,
    )
    title = field_col.text_input("Title", key="ti_title", label_visibility="collapsed")
    return title


def render_artist_options(artist_options: set[str], key: str, label: str | None = None, disabled: bool = False):
    with st.popover(f":material/groups: {label or ''}", use_container_width=True, disabled=disabled):
        if artist := sst.get(key):
            artist_options |= {artist}
        for artist in artist_options:
            st.button(artist, key=f"artist_option_{key}_{artist}", on_click=sst.__setitem__, args=(key, artist))


def artist_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None) -> str | list[str]:
    caption_col, field_col, buttons = build_component_columns(6)
    sst.setdefault("ti_artist", track_info.artist_str)
    caption_col.write(f"__Artists__{changed_string(track_info.artist_str, sst.ti_artist)}")
    next(buttons).button(
        ":material/cloud_download:",
        help="Copy Metadata from Soundcloud",
        on_click=sst.__setitem__,
        args=("ti_artist", sc_track_info and sc_track_info.artist_str),
        use_container_width=True,
        key="copy_artists",
        disabled=sc_track_info is None,
    )
    next(buttons).button(
        ":material/cleaning_services:",
        help="Clean",
        key="clean_artist",
        on_click=apply_to_sst(clean_artists, "ti_artist"),
        use_container_width=True,
    )
    next(buttons).button(
        ":material/arrow_upward:",
        help="Titelize",
        key="titelize_artist",
        on_click=apply_to_sst(titelize, "ti_artist"),
        use_container_width=True,
    )
    with next(buttons):
        render_artist_options(sc_track_info.artist_options if sc_track_info else set(), key="ti_artist")

    artist = field_col.text_input("Artist", key="ti_artist", label_visibility="collapsed")
    artists = [a.strip() for a in artist.split(",")]
    if len(artists) == 1:
        artists = artists[0]
    return artists


def artwork_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None, has_artwork: bool = False):
    caption_col, field_cols, buttons = build_component_columns(6, mid=(0.06, 0.44))
    help_str = ""
    if has_artwork:
        help_str += "Track already has artwork, no need to copy. "
    if not has_artwork and not sst.get("ti_artwork_url"):
        help_str += "Current track has no artwork, you should copy it."
    caption_col.markdown("__Artwork__", help=help_str)
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_artwork_sc",
        on_click=sst.__setitem__,
        args=("ti_artwork_url", sc_track_info and sc_track_info.artwork_url),
        use_container_width=True,
        disabled=sc_track_info is None,
    )
    next(buttons).button(
        ":material/delete:",
        key="delete_artwork",
        on_click=sst.__setitem__,
        args=("ti_artwork_url", ""),
        use_container_width=True,
        disabled=not has_artwork,
    )
    next(buttons).button(
        ":material/visibility:",
        help="Show Artwork",
        key="show_artwork",
        on_click=artwork_dialog,
        args=(track_info.artwork or sst.get("ti_artwork_url", ""),),
        use_container_width=True,
    )
    sst.setdefault("ti_artwork_url", track_info.artwork_url)
    artwork_url = field_cols[1].text_input("URL", key="ti_artwork_url", label_visibility="collapsed")
    if artwork_url or track_info.artwork:
        field_cols[0].image(artwork_url or track_info.artwork, width=int(ARTWORK_WIDTH / 2))
    return artwork_url


@st.dialog("Artwork")
def artwork_dialog(artwork: str | bytes):
    st.image(artwork)


def render_predictor(predictor: Predictor, filename: str, autopredict: bool = False):
    key = predictor.__class__.__name__
    if autopredict:
        if (pred := sst.get((filename, key))) is not None:
            return pred
        sst[(filename, key)] = predictor.predict(filename)
        return sst[(filename, key)]
    if st.button(f"Predict {predictor.title}", key=f"predict-{key}", help=predictor.help):
        sst[(filename, key)] = predictor.predict(filename)
    return sst.get((filename, key))


def genre_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None, filename: str) -> str:
    genres = [("Trance", ""), ("Hardtrance", ""), ("House", "")]
    caption_col, field_cols, buttons = build_component_columns(
        6, mid=tuple(0.5 / (len(genres) + 1) for _ in range(len(genres) + 1))
    )
    with caption_col:
        caption = ""
        if track_info.bpm:
            caption += f":gray-badge[BPM __{track_info.bpm}__]"
        if track_info.key:
            caption += f":gray-badge[Key __{track_info.key}__]"
        captions_str = f"{'&nbsp;' * 5} {caption}" if caption else ""
        st.write(f"__Genre__{changed_string(track_info.genre, sst.get('ti_genre'))}{captions_str}")

    for i, (genre, prob) in enumerate(genres, start=1):
        prob_str = prob and f" ({prob:.2f})"
        if field_cols[i].button(f"{genre}{prob_str}", use_container_width=True):
            sst.ti_genre = genre

    sst.setdefault("ti_genre", track_info.genre)
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_genre_sc",
        on_click=sst.__setitem__,
        args=("ti_genre", sc_track_info and sc_track_info.genre),
        use_container_width=True,
        disabled=sc_track_info is None,
    )
    next(buttons).button(
        ":material/arrow_upward:",
        help="Titelize",
        key="titelize_genre",
        on_click=apply_to_sst(titelize, "ti_genre"),
        use_container_width=True,
    )

    genre = field_cols[0].text_input("Genre", key="ti_genre", label_visibility="collapsed")
    return genre


def dates_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None):
    caption_col, field_col, buttons = build_component_columns(6)
    caption_col.write(f"__Release Date__{changed_string(track_info.release_date, sst.get('ti_release_date'))}")
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_dates_sc",
        on_click=lambda date: sst.__setitem__("ti_release_date", date),
        args=(sc_track_info and sc_track_info.release_date,),
        use_container_width=True,
        disabled=sc_track_info is None,
    )
    sst.setdefault("ti_release_date", track_info.release_date)
    release_date = field_col.date_input("Release Date", key="ti_release_date", label_visibility="collapsed")
    return release_date


def remix_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None) -> Remix | None:
    sst.setdefault("ti_is_remix", track_info.remix or is_remix(track_info.title) if track_info else False)
    remix_ = sc_track_info and sc_track_info.remix

    if remix := st.checkbox("Remix", key="ti_is_remix", label_visibility="collapsed", value=sst.ti_is_remix):
        sst.setdefault("ti_remixer", (track_info.remix and track_info.remix.remixer_str) or "")
        sst.setdefault("ti_original_artist", track_info.remix and track_info.remix.original_artist_str)
        sst.setdefault("ti_mix_name", track_info.remix and track_info.remix.mix_name)

    caption_col, field_col, buttons = build_component_columns(6)
    caption_col.write("__Remixer__")
    remixer = field_col.text_input("Remixer", key="ti_remixer", disabled=not remix, label_visibility="collapsed")
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_remixer_sc",
        on_click=sst.__setitem__,
        args=("ti_remixer", remix_ and remix_.remixer_str),
        use_container_width=True,
        disabled=(not remix) or remix_ is None,
    )
    next(buttons).button(
        ":material/cleaning_services:",
        help="Clean",
        key="clean_artist_remixer",
        on_click=apply_to_sst(clean_artists, "ti_remixer"),
        use_container_width=True,
        disabled=not remix,
    )
    next(buttons).button(
        ":material/arrow_upward:",
        help="Titelize",
        key="titelize_remixer",
        on_click=apply_to_sst(titelize, "ti_remixer"),
        use_container_width=True,
        disabled=not remix,
    )
    with next(buttons):
        render_artist_options(
            sc_track_info.artist_options if sc_track_info else set(),
            key="ti_remixer",
            disabled=not remix,
        )

    caption_col, field_col, buttons = build_component_columns(6)
    caption_col.write("__Original Artist__")
    original_artist = field_col.text_input(
        "Original Artist", key="ti_original_artist", disabled=not remix, label_visibility="collapsed"
    )
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_remix_original_artist",
        on_click=sst.__setitem__,
        args=("ti_original_artist", remix_ and remix_.original_artist_str),
        use_container_width=True,
        disabled=(not remix) or remix_ is None,
    )
    next(buttons).button(
        ":material/cleaning_services:",
        help="Clean",
        key="clean_artist_original_artist",
        on_click=apply_to_sst(clean_artists, "ti_original_artist"),
        use_container_width=True,
        disabled=not remix,
    )
    next(buttons).button(
        ":material/arrow_upward:",
        help="Titelize",
        key="titelize_original_artist",
        on_click=apply_to_sst(titelize, "ti_original_artist"),
        use_container_width=True,
        disabled=not remix,
    )
    with next(buttons):
        render_artist_options(
            sc_track_info.artist_options if sc_track_info else set(),
            key="ti_original_artist",
            disabled=not remix,
        )

    caption_col, field_col, buttons = build_component_columns(6)
    caption_col.write("__Mix Name__")
    mix_name = field_col.text_input("Mix Name", key="ti_mix_name", disabled=not remix, label_visibility="collapsed")
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_remix_name",
        on_click=sst.__setitem__,
        args=("ti_mix_name", remix_ and remix_.mix_name),
        use_container_width=True,
        disabled=(not remix) or remix_ is None,
    )
    next(buttons).button(
        ":material/arrow_upward:",
        help="Titelize",
        key="titelize_mix_name",
        on_click=apply_to_sst(titelize, "ti_mix_name"),
        use_container_width=True,
        disabled=not remix,
    )

    if not remix:
        return None
    return Remix(remixer=remixer or "", original_artist=original_artist or "", mix_name=mix_name or "")


def comment_editor(track_info: TrackInfo, sc_track_info: TrackInfo | None) -> Comment | None:
    caption_col, field_cols, buttons = build_component_columns(6, mid=(0.25, 0.25))
    sst.setdefault("ti_comment", track_info.comment.to_str() if track_info and track_info.comment else "")
    comment = sst.get("ti_comment")
    sst.setdefault("ti_comment_on_sc", True)
    on_soundcloud = field_cols[0].checkbox("On Soundcloud", key="ti_comment_on_sc")

    old_comment = track_info.comment.to_str() if track_info and track_info.comment else ""
    caption_col.write(f"__Comment__ {changed_string(old_comment, comment)}")

    track_id = Comment.from_str(comment).soundcloud_id
    if track_id and (track := asyncio.run(get_client().get_track(track_id=track_id))):
        with field_cols[1]:
            render_embedded_track(track, height=100)
    next(buttons).button(
        ":material/cloud_download:",
        key="copy_comments_sc",
        on_click=sst.__setitem__,
        args=("ti_comment", sc_track_info and sc_track_info.comment and sc_track_info.comment.to_str()),
        use_container_width=True,
        disabled=sc_track_info is None,
    )
    if not comment:
        return None
    out_comment = Comment.from_str(comment)
    if not on_soundcloud:
        out_comment.soundcloud_id = None
        out_comment.soundcloud_permalink = None
    field_cols[0].code(out_comment.to_str().replace("\n", "  \n"))
    return out_comment
