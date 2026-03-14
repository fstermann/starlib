import importlib.util
import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

import pandas as pd
import streamlit as st
from pyrekordbox import Rekordbox6Database
from streamlit import session_state as sst

from soundcloud_tools.handler.track import Comment as TrackComment
from soundcloud_tools.streamlit.utils import create_soundcloud_playlist

logger = logging.getLogger(__name__)

DB_PATH = Path.home() / "Library" / "Pioneer" / "rekordbox" / "master.db"


@dataclass
class RekordboxTrack:
    track_id: str
    name: str
    artist: str
    album: str
    genre: str
    bpm: float | None
    key: str
    rating: int
    duration: int  # seconds
    file_path: str
    label: str
    year: str
    comments: str
    date_added: str

    @property
    def duration_str(self) -> str:
        mins = self.duration // 60
        secs = self.duration % 60
        return f"{mins}:{secs:02d}"

    @property
    def stars(self) -> str:
        stars_map = {0: "☆☆☆☆☆", 51: "★☆☆☆☆", 102: "★★☆☆☆", 153: "★★★☆☆", 204: "★★★★☆", 255: "★★★★★"}
        return stars_map.get(self.rating, "")

    @property
    def soundcloud_id(self) -> int | None:
        """Parse the SoundCloud track ID from the comment field."""
        return TrackComment.from_str(self.comments).soundcloud_id


@dataclass
class RekordboxPlaylist:
    name: str
    track_ids: list[str] = field(default_factory=list)
    children: list["RekordboxPlaylist"] = field(default_factory=list)
    is_folder: bool = False

    @property
    def total_tracks(self) -> int:
        return len(self.track_ids) + sum(p.total_tracks for p in self.children)


def parse_collection_from_db() -> tuple[dict[str, RekordboxTrack], list[RekordboxPlaylist]]:
    """Load tracks and playlists directly from the Rekordbox 6/7 master.db (no manual export needed)."""

    db = Rekordbox6Database()

    # --- Tracks ---
    tracks: dict[str, RekordboxTrack] = {}
    for content in db.get_content():
        track_id = str(content.ID)
        bpm = content.BPM / 100.0 if content.BPM else None
        folder = content.FolderPath or ""
        filename = content.FileNameL or ""
        file_path = str(Path(folder) / filename) if folder and filename else folder or filename
        # DB stores Rating as 0-5; convert to XML-compatible 0/51/102/153/204/255
        db_rating = content.Rating or 0
        tracks[track_id] = RekordboxTrack(
            track_id=track_id,
            name=content.Title or "",
            artist=content.ArtistName or "",
            album=content.AlbumName or "",
            genre=content.GenreName or "",
            bpm=bpm,
            key=content.KeyName or "",
            rating=db_rating * 51,
            duration=content.Length or 0,
            file_path=file_path,
            label=content.LabelName or "",
            year=str(content.ReleaseYear) if content.ReleaseYear else "",
            comments=content.Commnt or "",
            date_added=str(content.DateCreated)[:10] if content.DateCreated else "",
        )

    # --- Playlists ---
    all_db_playlists = {pl.ID: pl for pl in db.get_playlist()}

    def build_node(pl_id: int) -> RekordboxPlaylist:
        pl = all_db_playlists[pl_id]
        is_folder = pl.Attribute == 1  # Attribute: 0=playlist, 1=folder, 4=smart playlist
        name = pl.Name or "Unnamed"
        if is_folder:
            children_raw = sorted(
                [p for p in all_db_playlists.values() if p.ParentID == str(pl_id)],
                key=lambda p: p.Seq or 0,
            )
            return RekordboxPlaylist(name=name, is_folder=True, children=[build_node(p.ID) for p in children_raw])
        track_ids = [str(song.ContentID) for song in sorted(pl.Songs, key=lambda s: s.TrackNo or 0)]
        return RekordboxPlaylist(name=name, track_ids=track_ids)

    root_playlists = sorted(
        [pl for pl in all_db_playlists.values() if pl.ParentID == "root"],
        key=lambda p: p.Seq or 0,
    )
    return tracks, [build_node(pl.ID) for pl in root_playlists]


def parse_rekordbox_xml(xml_content: str) -> tuple[dict[str, RekordboxTrack], list[RekordboxPlaylist]]:
    """Parse a Rekordbox XML export and return tracks dict and playlist tree."""
    root = ET.fromstring(xml_content)

    # Parse all tracks from COLLECTION
    tracks: dict[str, RekordboxTrack] = {}
    collection = root.find("COLLECTION")
    if collection is not None:
        for track_el in collection.findall("TRACK"):
            track_id = track_el.get("TrackID", "")
            try:
                bpm = float(track_el.get("AverageBpm", 0)) or None
            except (ValueError, TypeError):
                bpm = None

            try:
                duration = int(track_el.get("TotalTime", 0))
            except (ValueError, TypeError):
                duration = 0

            try:
                rating = int(track_el.get("Rating", 0))
            except (ValueError, TypeError):
                rating = 0

            raw_location = track_el.get("Location", "")
            # Decode percent-encoded path and strip file:// prefix
            file_path = unquote(raw_location.replace("file://localhost", "").replace("file://", ""))

            tracks[track_id] = RekordboxTrack(
                track_id=track_id,
                name=track_el.get("Name", ""),
                artist=track_el.get("Artist", ""),
                album=track_el.get("Album", ""),
                genre=track_el.get("Genre", ""),
                bpm=bpm,
                key=track_el.get("Tonality", ""),
                rating=rating,
                duration=duration,
                file_path=file_path,
                label=track_el.get("Label", ""),
                year=track_el.get("Year", ""),
                comments=track_el.get("Comments", ""),
                date_added=track_el.get("DateAdded", ""),
            )

    # Parse playlists from PLAYLISTS
    playlists: list[RekordboxPlaylist] = []
    playlists_el = root.find("PLAYLISTS")
    if playlists_el is not None:
        root_node = playlists_el.find("NODE")
        if root_node is not None:
            playlists = _parse_playlist_node_children(root_node)

    return tracks, playlists


def _parse_playlist_node_children(node: ET.Element) -> list[RekordboxPlaylist]:
    """Recursively parse playlist NODE elements."""
    result = []
    for child in node.findall("NODE"):
        node_type = child.get("Type", "0")
        name = child.get("Name", "Unknown")

        if node_type == "0":  # Folder
            playlist = RekordboxPlaylist(
                name=name,
                is_folder=True,
                children=_parse_playlist_node_children(child),
            )
        else:  # Playlist (Type == "1")
            track_ids = [t.get("Key", "") for t in child.findall("TRACK") if t.get("Key")]
            playlist = RekordboxPlaylist(name=name, track_ids=track_ids)

        result.append(playlist)
    return result


def flatten_playlists(playlists: list[RekordboxPlaylist], prefix: str = "") -> list[tuple[str, RekordboxPlaylist]]:
    """Flatten nested playlists to a list of (path, playlist) tuples."""
    result = []
    for p in playlists:
        path = f"{prefix}{p.name}" if not prefix else f"{prefix} / {p.name}"
        if p.is_folder:
            result.extend(flatten_playlists(p.children, path))
        else:
            result.append((path, p))
    return result


def render_playlist_tree(playlists: list[RekordboxPlaylist], indent: int = 0) -> str | None:
    """Render playlist tree as indented text for display."""
    lines = []
    for p in playlists:
        prefix = "  " * indent
        if p.is_folder:
            icon = "📁"
            count = f"({p.total_tracks} tracks)"
        else:
            icon = "🎵"
            count = f"({len(p.track_ids)} tracks)"
        lines.append(f"{prefix}{icon} **{p.name}** {count}")
        if p.children:
            lines.append(render_playlist_tree(p.children, indent + 1))
    return "\n".join(lines)


def tracks_to_dataframe(track_ids: list[str], tracks: dict[str, RekordboxTrack]) -> pd.DataFrame:
    """Convert a list of track IDs to a pandas DataFrame."""
    rows = []
    for i, tid in enumerate(track_ids, start=1):
        track = tracks.get(tid)
        if track:
            rows.append(
                {
                    "#": i,
                    "Artist": track.artist,
                    "Title": track.name,
                    "BPM": f"{track.bpm:.1f}" if track.bpm else "",
                    "Key": track.key,
                    "Genre": track.genre,
                    "Duration": track.duration_str,
                    "Rating": track.stars,
                    "Year": track.year,
                    "Album": track.album,
                    "Label": track.label,
                    "Date Added": track.date_added,
                }
            )
        else:
            rows.append({"#": i, "Artist": "?", "Title": f"Unknown track ({tid})"})
    return pd.DataFrame(rows)


def main():
    st.header(":material/queue_music: Rekordbox Viewer")

    sst.setdefault("rb_tracks", {})
    sst.setdefault("rb_playlists", [])
    sst.setdefault("rb_filename", "")
    sst.setdefault("rb_source", "")  # "db" or "xml"
    sst.setdefault("rb_selected_path", None)
    sst.setdefault("rb_selected_playlist", None)

    # Auto-load from DB on first page load
    db_available = DB_PATH.exists()
    if db_available and not sst.rb_source and importlib.util.find_spec("pyrekordbox") is not None:
        with st.spinner("Loading Rekordbox library…"):
            try:
                tracks, playlists = parse_collection_from_db()
                sst.rb_tracks = tracks
                sst.rb_playlists = playlists
                sst.rb_source = "db"
            except Exception as e:
                st.warning(f"Could not auto-load Rekordbox DB: {e}")

    with st.sidebar:
        # --- Source indicator + refresh ---
        if sst.rb_source == "db":
            col_status, col_refresh = st.columns([3, 1])
            col_status.success("🟢 Live DB")
            if col_refresh.button("🔄", help="Reload from master.db"):
                with st.spinner("Refreshing…"):
                    try:
                        tracks, playlists = parse_collection_from_db()
                        sst.rb_tracks = tracks
                        sst.rb_playlists = playlists
                        st.rerun()
                    except Exception as e:
                        st.error(f"Refresh failed: {e}")
        elif sst.rb_source == "xml":
            st.info("📄 XML file")

        # --- XML upload (fallback) ---
        with st.expander("📂 Load XML", expanded=not sst.rb_source):
            uploaded = st.file_uploader("Upload Rekordbox XML", type=["xml"], key="rb_upload")
            if uploaded and uploaded.name != sst.rb_filename:
                with st.spinner("Parsing XML…"):
                    try:
                        xml_content = uploaded.read().decode("utf-8")
                        tracks, playlists = parse_rekordbox_xml(xml_content)
                        sst.rb_tracks = tracks
                        sst.rb_playlists = playlists
                        sst.rb_filename = uploaded.name
                        sst.rb_source = "xml"
                        st.success(f"Loaded {len(tracks):,} tracks")
                    except Exception as e:
                        st.error(f"Failed to parse XML: {e}")
                        logger.exception("Error parsing Rekordbox XML")

        # --- Metrics ---
        if sst.rb_tracks:
            if sst.rb_source == "xml" and sst.rb_filename:
                st.caption(f"📄 **{sst.rb_filename}**")
            st.metric("Total Tracks", len(sst.rb_tracks))
            flat = flatten_playlists(sst.rb_playlists)
            st.metric("Playlists", len(flat))

    if not sst.rb_playlists:
        if db_available and importlib.util.find_spec("pyrekordbox") is None:
            st.warning(
                "**pyrekordbox** is not installed. Install it to enable auto-loading "
                "from your Rekordbox library without a manual export:\n\n"
                "```\npip install pyrekordbox\n```",
                icon="⚠️",
            )
        st.info("No collection loaded — upload a Rekordbox XML export using the sidebar.")
        with st.expander("ℹ️ How to export from Rekordbox"):
            st.markdown(
                """
1. Open **Rekordbox**
2. Go to **File → Export Collection in xml format**
3. Save the file and upload it here

The XML contains all your tracks and playlist structure.
"""
            )
        st.stop()

    tab_playlists, tab_collection = st.tabs(["🎵 Playlists", "📚 Full Collection"])

    # --- Playlists tab ---
    with tab_playlists:
        if not sst.rb_playlists:
            st.warning("No playlists found.")
        else:
            col_tree, col_tracks = st.columns([1, 2])

            with col_tree:
                st.write("#### Playlists")
                search = st.text_input("🔍 Filter playlists", key="rb_playlist_search", placeholder="Search…")

                # Build tree list of (label, path, playlist|None)
                # Folders are included as non-selectable visual separators using tree chars
                def build_options(
                    playlists: list[RekordboxPlaylist], prefix: str = "", trunk: str = ""
                ) -> list[tuple[str, str, RekordboxPlaylist | None]]:
                    rows = []
                    for i, p in enumerate(playlists):
                        is_last = i == len(playlists) - 1
                        connector = "└── " if is_last else "├── "
                        child_trunk = trunk + ("    " if is_last else "│   ")
                        path = p.name if not prefix else f"{prefix} / {p.name}"
                        if p.is_folder:
                            rows.append((trunk + connector + f"📁 {p.name}", path, None))
                            rows.extend(build_options(p.children, path, child_trunk))
                        else:
                            rows.append((trunk + connector + f"{p.name}  ({len(p.track_ids)})", path, p))
                    return rows

                all_options = build_options(sst.rb_playlists)

                if search:
                    q = search.lower()
                    all_options = [
                        (f"{path}  ({len(pl.track_ids)})", path, pl)
                        for _, path, pl in all_options
                        if pl is not None and q in path.lower()
                    ]

                if not all_options:
                    st.info("No playlists match your search.")
                else:
                    selected_idx = st.radio(
                        "Select playlist",
                        range(len(all_options)),
                        format_func=lambda i: all_options[i][0],
                        key="rb_pl_radio",
                        label_visibility="collapsed",
                    )
                    _, sst.rb_selected_path, sst.rb_selected_playlist = all_options[selected_idx]

            with col_tracks:
                if sst.rb_selected_playlist is not None:
                    st.write(f"#### {sst.rb_selected_path.split(' / ')[-1]}")
                    st.caption(f"Path: {sst.rb_selected_path}")

                    df = tracks_to_dataframe(sst.rb_selected_playlist.track_ids, sst.rb_tracks)

                    if df.empty:
                        st.info("This playlist is empty.")
                    else:
                        # Summary metrics
                        m1, m2, m3 = st.columns(3)
                        m1.metric("Tracks", len(df))

                        bpm_values = [
                            sst.rb_tracks[tid].bpm
                            for tid in sst.rb_selected_playlist.track_ids
                            if tid in sst.rb_tracks and sst.rb_tracks[tid].bpm
                        ]
                        if bpm_values:
                            m2.metric("Avg BPM", f"{sum(bpm_values) / len(bpm_values):.1f}")
                            m3.metric("BPM Range", f"{min(bpm_values):.0f} – {max(bpm_values):.0f}")

                        # Column visibility toggle
                        with st.expander("⚙️ Column visibility", expanded=False):
                            all_cols = [
                                "#",
                                "Artist",
                                "Title",
                                "BPM",
                                "Key",
                                "Genre",
                                "Duration",
                                "Rating",
                                "Year",
                                "Album",
                                "Label",
                                "Date Added",
                            ]
                            visible_cols = st.multiselect(
                                "Show columns",
                                all_cols,
                                default=["#", "Artist", "Title", "BPM", "Key", "Genre", "Duration", "Rating"],
                                key="rb_visible_cols",
                            )

                        display_df = df[[c for c in visible_cols if c in df.columns]]
                        st.dataframe(display_df, use_container_width=True, hide_index=True)

                        # Export button
                        csv = df.to_csv(index=False).encode("utf-8")
                        st.download_button(
                            "⬇️ Export as CSV",
                            data=csv,
                            file_name=f"{sst.rb_selected_path.replace(' / ', '_')}.csv",
                            mime="text/csv",
                        )

                        st.divider()
                        st.write("**☁️ SoundCloud Playlist**")
                        sc_track_ids = [
                            sst.rb_tracks[tid].soundcloud_id
                            for tid in sst.rb_selected_playlist.track_ids
                            if tid in sst.rb_tracks and sst.rb_tracks[tid].soundcloud_id is not None
                        ]
                        n_total = len(sst.rb_selected_playlist.track_ids)
                        n_sc = len(sc_track_ids)
                        if n_sc > 0:
                            st.caption(f"{n_sc} / {n_total} tracks have a SoundCloud ID in their comment field")
                            sc_title = st.text_input(
                                "Playlist title",
                                value=sst.rb_selected_path.split(" / ")[-1],
                                key=f"rb_sc_playlist_title_{sst.rb_selected_path.replace(' / ', '_')}",
                            )
                            if st.button(
                                "☁️ Create SoundCloud Playlist",
                                type="primary",
                                key="rb_create_sc_playlist",
                                use_container_width=True,
                            ):
                                create_soundcloud_playlist(
                                    title=sc_title,
                                    description=f"Imported from Rekordbox playlist: {sst.rb_selected_path}",
                                    track_ids=sc_track_ids,
                                    tag_list="rekordbox,soundcloud-tools",
                                )
                        else:
                            st.caption(f"0 / {n_total} tracks have SoundCloud IDs — cannot create SC playlist")
                elif sst.rb_selected_path is not None:
                    st.info("📁 This is a folder — select a playlist inside it.")
                else:
                    st.info("← Select a playlist from the tree to view its tracks.")

    # --- Full Collection tab ---
    with tab_collection:
        st.write("#### All Tracks")

        # Search & filter
        c1, c2, c3 = st.columns(3)
        col_search = c1.text_input("🔍 Search (artist / title)", key="rb_col_search")
        col_genre = c2.selectbox(
            "Genre",
            ["All"] + sorted({t.genre for t in sst.rb_tracks.values() if t.genre}),
            key="rb_col_genre",
        )
        col_sort = c3.selectbox("Sort by", ["Artist", "Title", "BPM", "Genre", "Date Added"], key="rb_col_sort")

        all_tracks = list(sst.rb_tracks.values())

        # Apply filters
        if col_search:
            q = col_search.lower()
            all_tracks = [t for t in all_tracks if q in t.artist.lower() or q in t.name.lower()]
        if col_genre != "All":
            all_tracks = [t for t in all_tracks if t.genre == col_genre]

        # Sort
        sort_key_map = {
            "Artist": lambda t: t.artist.lower(),
            "Title": lambda t: t.name.lower(),
            "BPM": lambda t: t.bpm or 0,
            "Genre": lambda t: t.genre.lower(),
            "Date Added": lambda t: t.date_added,
        }
        all_tracks.sort(key=sort_key_map[col_sort])

        st.caption(f"Showing {len(all_tracks):,} of {len(sst.rb_tracks):,} tracks")

        rows = [
            {
                "Artist": t.artist,
                "Title": t.name,
                "BPM": f"{t.bpm:.1f}" if t.bpm else "",
                "Key": t.key,
                "Genre": t.genre,
                "Duration": t.duration_str,
                "Rating": t.stars,
                "Year": t.year,
                "Album": t.album,
                "Label": t.label,
                "Date Added": t.date_added,
            }
            for t in all_tracks
        ]
        collection_df = pd.DataFrame(rows)
        st.dataframe(collection_df, use_container_width=True, hide_index=True)

        if not collection_df.empty:
            csv = collection_df.to_csv(index=False).encode("utf-8")
            st.download_button(
                "⬇️ Export as CSV",
                data=csv,
                file_name="rekordbox_collection.csv",
                mime="text/csv",
            )


if __name__ == "__main__":
    main()
