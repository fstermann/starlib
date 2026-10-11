"""Tests for editing regular playlists of the local Rekordbox library.

Builds a plain (unencrypted) SQLite ``master.db`` from pyrekordbox's own table
models and points a ``LocalMasterDbSource`` at it, so the real pyrekordbox write
path runs offline.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables
from sqlalchemy import create_engine
from sqlalchemy.schema import CreateTable

from backend.services.rekordbox import (
    BackupFailed,
    LocalMasterDbSource,
    PlaylistEditError,
    RekordboxBusy,
    rekordbox_running,
)

_TS = "2026-01-01 00:00:00.000 +00:00"


def _insert(con: sqlite3.Connection, table: str, **values: object) -> None:
    row: dict[str, object] = {"created_at": _TS, "updated_at": _TS, **values}
    columns = ",".join(row)
    placeholders = ",".join("?" * len(row))
    con.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", list(row.values()))


def build_master_db(path: Path) -> Rekordbox6Database:
    """Create a minimal library: tracks 1-3, playlist 10 holding 1, 2, 3, a smart playlist 20, folder 30.

    The pyrekordbox models mark sync columns NOT NULL, while Rekordbox's real
    schema leaves them nullable until commit, so the constraint is dropped.
    """
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as conn:
        for table in tables.Base.metadata.sorted_tables:
            conn.exec_driver_sql(str(CreateTable(table).compile(engine)).replace(" NOT NULL", ""))
    con = sqlite3.connect(path)
    _insert(con, "agentRegistry", registry_id="localUpdateCount", int_1=0)
    for i in (1, 2, 3):
        _insert(con, "djmdContent", ID=str(i), Title=f"Track {i}")
    _insert(con, "djmdPlaylist", ID="10", Name="Set", Attribute=0, ParentID="root", Seq=1)
    _insert(con, "djmdPlaylist", ID="20", Name="Smart", Attribute=4, ParentID="root", Seq=2)
    _insert(con, "djmdPlaylist", ID="30", Name="Folder", Attribute=1, ParentID="root", Seq=3)
    for track_no, content_id in enumerate(("1", "2", "3"), start=1):
        _insert(
            con,
            "djmdSongPlaylist",
            ID=f"e{content_id}",
            PlaylistID="10",
            ContentID=content_id,
            TrackNo=track_no,
            UUID=f"u{content_id}",
        )
    con.commit()
    con.close()
    return Rekordbox6Database(path, unlock=False)


def set_rekordbox_running(monkeypatch: pytest.MonkeyPatch, running: bool) -> None:
    pid = 4242 if running else 0
    monkeypatch.setattr("pyrekordbox.utils.get_rekordbox_pid", lambda *_: pid)
    monkeypatch.setattr("pyrekordbox.db6.database.get_rekordbox_pid", lambda *_: pid)


@pytest.fixture
def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> LocalMasterDbSource:
    set_rekordbox_running(monkeypatch, False)
    src = LocalMasterDbSource()
    src._db = build_master_db(tmp_path / "master.db")
    return src


def _titles(source: LocalMasterDbSource) -> list[str]:
    return [t.title for t in source.list_playlist_tracks("10")]


def test_playlist_tracks_carry_entry_ids(source: LocalMasterDbSource) -> None:
    assert [t.entry_id for t in source.list_playlist_tracks("10")] == ["e1", "e2", "e3"]


def test_add_appends_tracks_including_duplicates(source: LocalMasterDbSource) -> None:
    tracks = source.add_tracks_to_playlist("10", ["2", "1"])

    assert [t.title for t in tracks] == ["Track 1", "Track 2", "Track 3", "Track 2", "Track 1"]
    assert len({t.entry_id for t in tracks}) == 5


def test_remove_deletes_only_the_given_entries(source: LocalMasterDbSource) -> None:
    source.add_tracks_to_playlist("10", ["1"])
    duplicate = source.list_playlist_tracks("10")[-1].entry_id
    assert duplicate is not None

    tracks = source.remove_playlist_entries("10", [duplicate, "e2"])

    assert [t.title for t in tracks] == ["Track 1", "Track 3"]


def test_reorder_applies_the_full_order(source: LocalMasterDbSource) -> None:
    tracks = source.reorder_playlist("10", ["e3", "e1", "e2"])

    assert [t.title for t in tracks] == ["Track 3", "Track 1", "Track 2"]
    assert _titles(source) == ["Track 3", "Track 1", "Track 2"]


@pytest.mark.parametrize("order", [["e1", "e2"], ["e1", "e2", "e2"], ["e1", "e2", "x"]])
def test_reorder_rejects_an_incomplete_order(source: LocalMasterDbSource, order: list[str]) -> None:
    with pytest.raises(PlaylistEditError):
        source.reorder_playlist("10", order)
    assert _titles(source) == ["Track 1", "Track 2", "Track 3"]


def test_unknown_ids_change_nothing(source: LocalMasterDbSource) -> None:
    with pytest.raises(PlaylistEditError):
        source.add_tracks_to_playlist("10", ["1", "999"])
    with pytest.raises(PlaylistEditError):
        source.remove_playlist_entries("10", ["e1", "missing"])
    assert _titles(source) == ["Track 1", "Track 2", "Track 3"]


def test_smart_playlists_cannot_be_edited(source: LocalMasterDbSource) -> None:
    with pytest.raises(PlaylistEditError):
        source.add_tracks_to_playlist("20", ["1"])


def test_edits_are_refused_while_rekordbox_runs(source: LocalMasterDbSource, monkeypatch: pytest.MonkeyPatch) -> None:
    set_rekordbox_running(monkeypatch, True)

    with pytest.raises(RekordboxBusy):
        source.remove_playlist_entries("10", ["e1"])
    assert _titles(source) == ["Track 1", "Track 2", "Track 3"]


def _playlists(source: LocalMasterDbSource) -> dict[str, tuple[str, str | None, bool]]:
    return {p.id: (p.name, p.parent_id, p.is_folder) for p in source.list_playlists()}


def test_create_playlist_and_folder(source: LocalMasterDbSource) -> None:
    folder = source.create_playlist(" Crates ", None, folder=True)
    playlist = source.create_playlist("Warmup", folder.id, folder=False)

    assert (folder.name, folder.parent_id, folder.is_folder) == ("Crates", None, True)
    assert (playlist.name, playlist.parent_id, playlist.is_folder, playlist.track_count) == (
        "Warmup",
        folder.id,
        False,
        0,
    )
    assert _playlists(source)[playlist.id] == ("Warmup", folder.id, False)
    assert source.add_tracks_to_playlist(playlist.id, ["1"])[0].title == "Track 1"


@pytest.mark.parametrize(("name", "parent_id"), [("  ", None), ("X", "10"), ("X", "999")])
def test_create_rejects_blank_names_and_non_folder_parents(
    source: LocalMasterDbSource, name: str, parent_id: str | None
) -> None:
    with pytest.raises(PlaylistEditError):
        source.create_playlist(name, parent_id, folder=False)
    assert set(_playlists(source)) == {"10", "20", "30"}


def test_delete_playlist_keeps_the_tracks(source: LocalMasterDbSource) -> None:
    source.delete_playlist("10")

    assert set(_playlists(source)) == {"20", "30"}
    assert len(source.list_all_tracks()) == 3


def test_delete_folder_removes_its_playlists(source: LocalMasterDbSource) -> None:
    inner = source.create_playlist("Inner", "30", folder=False)

    source.delete_playlist("30")

    assert inner.id not in _playlists(source)
    assert "30" not in _playlists(source)


def test_create_and_delete_are_refused_while_rekordbox_runs(
    source: LocalMasterDbSource, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_rekordbox_running(monkeypatch, True)

    assert rekordbox_running()
    with pytest.raises(RekordboxBusy):
        source.create_playlist("New", None, folder=False)
    with pytest.raises(RekordboxBusy):
        source.delete_playlist("10")
    assert set(_playlists(source)) == {"10", "20", "30"}


@pytest.mark.parametrize("playlist_id", ["10", "20", "30"])
def test_rename_playlists_and_folders(source: LocalMasterDbSource, playlist_id: str) -> None:
    renamed = source.rename_playlist(playlist_id, " Renamed ")

    assert renamed.name == "Renamed"
    assert _playlists(source)[playlist_id][0] == "Renamed"


@pytest.mark.parametrize(("playlist_id", "name"), [("10", "  "), ("999", "X")])
def test_rename_rejects_blank_names_and_unknown_playlists(
    source: LocalMasterDbSource, playlist_id: str, name: str
) -> None:
    with pytest.raises(PlaylistEditError):
        source.rename_playlist(playlist_id, name)
    assert _playlists(source)["10"][0] == "Set"


def test_rename_is_refused_while_rekordbox_runs(source: LocalMasterDbSource, monkeypatch: pytest.MonkeyPatch) -> None:
    set_rekordbox_running(monkeypatch, True)

    with pytest.raises(RekordboxBusy):
        source.rename_playlist("30", "New")
    assert _playlists(source)["30"][0] == "Folder"


@pytest.fixture
def backed_up_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> LocalMasterDbSource:
    set_rekordbox_running(monkeypatch, False)
    src = LocalMasterDbSource(backup_dir=tmp_path / "backups")
    src._db = build_master_db(tmp_path / "master.db")
    return src


def test_first_edit_backs_up_the_library_before_writing(backed_up_source: LocalMasterDbSource, tmp_path: Path) -> None:
    backed_up_source.remove_playlist_entries("10", ["e1"])
    backed_up_source.remove_playlist_entries("10", ["e2"])

    backups = list((tmp_path / "backups").iterdir())
    assert len(backups) == 1
    restored = LocalMasterDbSource()
    restored._db = Rekordbox6Database(backups[0] / "master.db", unlock=False)
    assert _titles(restored) == ["Track 1", "Track 2", "Track 3"]


def test_edit_is_refused_when_the_backup_fails(
    backed_up_source: LocalMasterDbSource, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*_: object) -> Path:
        raise OSError("disk full")

    monkeypatch.setattr("backend.services.rekordbox.local.backup_master_db", fail)

    with pytest.raises(BackupFailed):
        backed_up_source.remove_playlist_entries("10", ["e1"])
    assert _titles(backed_up_source) == ["Track 1", "Track 2", "Track 3"]
