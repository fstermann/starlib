import asyncio
import logging
from copy import copy
from pathlib import Path
from typing import Any, Literal

import streamlit as st
from mutagen.id3 import APIC, ID3FileType
from streamlit import session_state as sst

from soundcloud_tools.handler.track import TrackHandler, TrackInfo
from soundcloud_tools.models import Track
from soundcloud_tools.streamlit.client import get_client
from soundcloud_tools.streamlit.components import (
    ARTWORK_WIDTH,
    artist_editor,
    artwork_editor,
    comment_editor,
    dates_editor,
    genre_editor,
    remix_editor,
    title_editor,
)
from soundcloud_tools.streamlit.file_selection import file_selector
from soundcloud_tools.streamlit.utils import apply_to_sst, render_embedded_track, reset_track_info_sst, table
from soundcloud_tools.utils.string import (
    changed_string,
    clean_artists,
    clean_title,
    remove_double_spaces,
    remove_free_dl,
    remove_original_mix,
    remove_remix,
    replace_underscores,
    titelize,
)

logger = logging.getLogger(__name__)


@st.dialog("Delete")
def delete_file(handler: TrackHandler):
    if st.button("Delete", key="del_inner"):
        handler.delete()
        st.success("Deleted Successfully")
        st.rerun()


def render_file(file: Path, root_folder: Path):
    st.write(f"### $\\;\\tiny\\textsf{{{file.parent}}}/$ {file.name}")
    handler = TrackHandler(root_folder=root_folder, file=file)
    if not sst.get("ti_title"):
        copy_track_info(handler.track_info)
    sst.finalize_disabled = file.parent.name != "prepare"

    with open(file, "rb") as f:
        st.audio(f)

    st.divider()

    # Metadata
    with st.sidebar.container(border=True):
        clean_title = remove_double_spaces(remove_remix(replace_underscores(remove_free_dl(handler.file.stem))))
        sc_track_info = render_soundcloud_search(clean_title)

    c1, c2 = st.columns((3, 6.5))
    c1.subheader(":material/description: Edit Track Metadata")
    with c1.container(border=True):
        render_auto_checkboxes(handler, sc_track_info)
    modified_info = modify_track_info(
        handler.track_info,
        filename=str(handler.file),
        has_artwork=bool(handler.covers),
        sc_track_info=sc_track_info,
    )
    with c2.container(border=True):
        col_artwork, col_title, col_button = st.columns((1, 5, 1))
        if col_button.button(
            ":material/save:",
            help=f"Save Metadata\n\n_Generated Filename:_ `{modified_info.filename}`",
            use_container_width=True,
            key="save_file",
        ):
            handler.add_info(modified_info, artwork=modified_info.artwork)
            if not modified_info.remix:
                handler.remove_remix()
            sst.new_track_name = handler.rename(modified_info.filename)
            st.rerun()

        render_track_info(handler.track_info, title_col=col_title, comment_col=col_button, artwork_col=col_artwork)

    with st.expander("Cover Handler"):
        cover_handler(handler.track, artwork=modified_info.artwork)

    with st.expander("Tags"):
        for tag in handler.track.tags:
            st.write(tag, handler.track.tags[tag])


def copy_track_info(track_info: TrackInfo, only_missing: bool = False):
    state_info_map = {
        "ti_title": track_info.title,
        "ti_artist": track_info.artist_str,
        "ti_genre": track_info.genre,
        "ti_release_date": track_info.release_date,
        "ti_remixer": track_info.remix and track_info.remix.remixer_str,
        "ti_original_artist": track_info.remix and track_info.remix.original_artist_str,
        "ti_mix_name": track_info.remix and track_info.remix.mix_name,
        "ti_comment": track_info.comment and track_info.comment.to_str(),
    }
    for key, value in state_info_map.items():
        if only_missing and sst.get(key):
            continue
        sst[key] = value


def copy_artwork(artwork_url: str | None):
    sst.ti_artwork_url = artwork_url


def render_soundcloud_search(query: str) -> TrackInfo | None:
    st.write("__:material/cloud: Soundcloud Search__")
    if not st.toggle("Enable", value=True):
        return None
    query = st.text_input("Search", query)
    url_ph = st.empty()
    st.divider()
    track_ph = st.container(border=True)
    if track_url := url_ph.text_input("Url", key="ti_search_url"):
        if not (track_id := asyncio.run(get_client().get_track_id(url=track_url))):
            st.error("Could not find track id from url")
            return None
        if not (track := asyncio.run(get_client().get_track(track_id=track_id))):
            st.error("Track with id=`{track_id}` not found")
            return None
    else:
        sst.setdefault("search_result", {})
        sst.search_result[query] = asyncio.run(get_client().search(q=query))
        if not (result := sst.search_result.get(query)):
            return None

        tracks: list[Track] = [track for track in result.collection if track.kind == "track"]
        if not tracks:
            st.warning("No tracks found")
            return None

        track = st.radio("Tracks", tracks, format_func=lambda t: f"[{t.title} - {t.user.username}]({t.permalink_url})")

    st.divider()

    track_info = TrackInfo.from_sc_track(track)
    with track_ph:
        render_embedded_track(track)
        c1, c2 = st.columns(2)
        c1.button(
            ":material/cloud_download:",
            help="Copy Metadata from Soundcloud",
            use_container_width=True,
            on_click=copy_track_info,
            args=(track_info,),
        )
        c2.button(
            ":material/library_music:",
            help="Copy Artwork from Soundcloud",
            use_container_width=True,
            on_click=copy_artwork,
            args=(track_info.artwork_url,),
        )
    with st.expander("Track Metadata"):
        st.write(track)
    return track_info


def render_auto_checkboxes(handler: TrackHandler, sc_track_info: TrackInfo | None):
    cols = st.columns(6)
    if handler.mp3_file.exists():
        st.warning("File already exists in export folder")
    cols[0].button(
        ":material/cloud_download:",
        help="Copy complete metadata from Soundcloud",
        key="copy_metadata",
        on_click=copy_track_info,
        args=(sc_track_info,),
        disabled=sc_track_info is None,
        use_container_width=True,
    )

    cols[1].button(":material/refresh:", use_container_width=True)

    cols[2].button(
        ":material/delete:",
        key="del_outer",
        help="Delete file",
        use_container_width=True,
        on_click=delete_file,
        args=(handler,),
    )

    cols[3].button(
        ":material/signature:",
        key="rename",
        use_container_width=True,
        disabled=handler.track_info.filename == handler.file.stem,
        help=f"Filename does not match track info, rename to '{handler.track_info.filename}'",
        on_click=lambda: setattr(sst, "new_track_name", handler.rename(handler.track_info.filename)),
    )

    config_popover = cols[4].popover(":material/motion_photos_auto:", use_container_width=True)

    with config_popover:
        st.selectbox(
            "Convert to", ["aiff", "mp3"], key="convert_format", help="Convert to mp3 or aiff format on export"
        )

    cols[5].button(
        ":material/done_all:",
        help=(
            f"Track has {len(handler.covers)} covers, "
            f"Metadata {'' if handler.track_info.complete else 'not '}complete.\n"
            f"Export to {sst.convert_format}."
        ),
        disabled=any((sst.finalize_disabled, len(handler.covers) != 1, not handler.track_info.complete)),
        use_container_width=True,
        on_click=finalize,
        args=(handler, sst.convert_format),
        type="primary",
    )
    with config_popover:
        st.caption("Auto-Actions")
        if st.checkbox(
            ":material/add_photo_alternate: Artwork",
            value=True,
            key="auto_copy_artwork",
            help="Automatically copy artwork if not present",
        ):
            if not handler.track_info.artwork and sc_track_info:
                copy_artwork(sc_track_info.artwork_url)
        if st.checkbox(
            ":material/cloud_download: Metadata",
            value=True,
            key="auto_copy_metadata",
            help="Automatically copy metadata if not present",
        ):
            if sc_track_info:
                copy_track_info(sc_track_info, only_missing=True)
        if st.checkbox(
            ":material/cleaning_services: Clean",
            value=True,
            key="auto_clean",
            help=(
                "Automatically cleanup Title and Artists "
                "(Removes Free DL mentions, artists in title and separates artists into a list)"
            ),
        ):
            apply_to_sst(clean_title, "ti_title")()
            apply_to_sst(clean_artists, "ti_artist")()
        if st.checkbox(
            ":material/arrow_upward: Titelize",
            value=False,
            key="auto_titelize",
            help="Automatically titelizes Artists and Title",
        ):
            apply_to_sst(titelize, "ti_title")()
            apply_to_sst(titelize, "ti_artist")()
        if st.checkbox(
            ":material/remove_circle: Remove 'Original Mix'",
            value=True,
            key="auto_remove_original_mix",
            help="Automatically remove 'Original Mix' from title",
        ):
            apply_to_sst(remove_original_mix, "ti_title")()


def finalize(handler: TrackHandler, convert_format: Literal["mp3", "aiff"]):
    with st.spinner("Finalizing"):
        if handler.file.suffix == f".{convert_format}":
            handler.move_to_cleaned()
        else:
            match convert_format:
                case "mp3":
                    if not handler.convert_to_mp3():
                        st.warning("Could not convert to mp3")
                        handler.move_to_cleaned()
                    else:
                        handler.add_mp3_info()
                        handler.archive()
                case "aiff":
                    if not handler.convert_to_aiff():
                        st.warning("Could not convert to aiff")
                        handler.move_to_cleaned()
                    else:
                        handler.add_aiff_info()
                        handler.archive()
    reset_track_info_sst()


def modify_track_info(
    track_info: TrackInfo,
    sc_track_info: TrackInfo | None,
    filename: str,
    has_artwork: bool = False,
) -> TrackInfo:
    title = title_editor(track_info, sc_track_info)

    artists = artist_editor(track_info, sc_track_info)

    release_date = dates_editor(track_info, sc_track_info)

    genre = genre_editor(track_info, sc_track_info, filename=filename)

    artwork_url = artwork_editor(track_info, sc_track_info, has_artwork=has_artwork)

    with st.container(border=True):
        remix = remix_editor(track_info, sc_track_info)

    comment = comment_editor(track_info, sc_track_info)

    return TrackInfo(
        title=title,
        artist=artists,
        genre=genre,
        release_date=release_date,
        artwork_url=artwork_url,
        remix=remix,
        comment=comment,
    )


def render_as_table(data: dict[str, Any]):
    def prepare_key(k):
        return "<b>" + k.replace("_", " ").title() + "</b>"

    def prepare_value(v):
        if isinstance(v, list):
            v = ", ".join(v)
        return v or "⚠️"

    prepared_data = [(prepare_key(k), prepare_value(v)) for k, v in data.items()]
    table(prepared_data)


def render_track_info(track_info: TrackInfo, title_col, comment_col, artwork_col):
    old_comment = track_info.comment and track_info.comment.to_str()
    new_comment = sst.ti_comment
    with comment_col.popover(
        f":material/comment: {changed_string(old_comment, new_comment)}", use_container_width=True
    ):
        st.caption("Comment")
        if comment := (track_info.comment and track_info.comment.to_str().replace("\n", "  \n")):
            st.code(comment)
            if (
                track_info.comment
                and track_info.comment.soundcloud_id
                and (track := asyncio.run(get_client().get_track(track_id=track_info.comment.soundcloud_id)))
            ):
                render_embedded_track(track, height=100)
        else:
            st.warning("No Comment")

    with title_col:
        st.write(f"__{track_info.title}__")
        st.caption(track_info.artist_str)
        caption = " | ".join(
            (
                f":blue-badge[{track_info.genre or '_No Genre_'}]",
                f":gray-badge[{track_info.release_date or '_No Release Date_'}]",
            )
        )
        st.write(caption)
        if track_info.remix:
            st.write(
                f":violet-badge[$\\tiny{{\\texttt{{Original Artist}}}}$ {track_info.remix.original_artist_str}] | "
                f":violet-badge[$\\tiny{{\\texttt{{Remixer}}}}$ {track_info.remix.remixer_str}] | "
                f":violet-badge[$\\tiny{{\\texttt{{Mix Name}}}}$ {track_info.remix.mix_name}]"
            )

    with artwork_col:
        if track_info.artwork:
            st.image(track_info.artwork, width=ARTWORK_WIDTH)
            if track_info.artwork_url:
                st.caption(track_info.artwork_url)
        else:
            st.error("No Artwork")


def cover_handler(track: ID3FileType, artwork: bytes | None = None):
    c1, c2 = st.columns(2)
    c1.write("__Artwork__")

    if covers := track.tags.getall("APIC"):
        c2.write(f"Track has {len(covers)} covers")
    else:
        c2.error("Track has no covers")

    c1, c2, c3 = st.columns(3)
    if c2.button(":material/delete:", key=f"remove_all_{bool(artwork)}", use_container_width=True):
        track.tags.delall("APIC")
        track.save()
        st.success("Covers removed")
    if artwork and c1.button(":material/add:", key=f"{bool(artwork)}", use_container_width=True):
        track.tags.add(
            APIC(
                encoding=0,
                mime="image/jpeg",
                type=3,
                desc="Cover",
                data=artwork,
            )
        )
        track.save()
        st.success("Artwork added")
    c3.button(":material/refresh:", key=f"reload_{bool(artwork)}", use_container_width=True)

    st.divider()

    all_covers = copy(covers)
    for i, cover in enumerate(covers):
        c1, c2 = st.columns((1, 2))
        c1.image(cover.data, caption=f"Cover {i}", width=ARTWORK_WIDTH)
        file_name = f"{track.tags.get('TPE1', '')}-{track.tags.get('TPE1', '')}_cover_{i}.jpg"
        c2.download_button(f":material/download: {i}", data=cover.data, file_name=file_name, key=file_name)
        if c2.button(":material/delete:", key=f"remove_{i}_{bool(artwork)}"):
            all_covers.pop(i)
            track.tags.delall("APIC")
            track.tags.setall("APIC", all_covers)
            st.rerun()


def main():
    st.header(":material/database: MetaEditor")
    st.write("Edit track metadata with integrated Soundcloud search and export to 320kb/s mp3 files.")
    st.divider()

    with st.sidebar:
        file, root_folder = file_selector()
        if file is None:
            st.warning("No files present in folder")
            return

    render_file(file, root_folder)


if __name__ == "__main__":
    main()
