"""Tests for the USB export source (Rekordbox Device Library Plus).

Builds a synthetic, SQLCipher-sealed ``exportLibrary.db`` plus the artwork and
ANLZ sidecar files it references, all under a temporary device tree — so the
suite exercises the real ``UsbExportSource`` offline, without a mounted stick.
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

from backend.core.services.rekordbox import RekordboxUnavailable, UsbExportSource
from backend.core.services.rekordbox.usb import _DEVICE_LIBRARY_KEY

sqlite = pytest.importorskip("sqlcipher3").dbapi2

_SCHEMA = """
CREATE TABLE artist (artist_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE album (album_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE genre (genre_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE key (key_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE image (image_id INTEGER PRIMARY KEY, path TEXT);
CREATE TABLE content (
  content_id INTEGER PRIMARY KEY, title TEXT, bpmx100 INTEGER, length INTEGER,
  path TEXT, djComment TEXT, dateAdded TEXT, releaseDate TEXT, image_id INTEGER,
  analysisDataFilePath TEXT, artist_id_artist INTEGER, album_id INTEGER,
  genre_id INTEGER, key_id INTEGER
);
CREATE TABLE playlist (
  playlist_id INTEGER PRIMARY KEY, sequenceNo INTEGER, name TEXT,
  attribute INTEGER, playlist_id_parent INTEGER
);
CREATE TABLE playlist_content (playlist_id INTEGER, content_id INTEGER, sequenceNo INTEGER);
"""


def _anlz_ext_with_pwv4(entries: bytes) -> bytes:
    """Build a minimal ANLZ ``.EXT`` payload carrying one PWV4 tag."""
    n = len(entries) // 6
    tag = b"PWV4" + struct.pack(">III", 24, 24 + len(entries), 6) + struct.pack(">II", n, 0) + entries
    header = b"PMAI" + struct.pack(">II", 16, 16 + len(tag)) + struct.pack(">I", 0)
    return header + tag


def _anlz_dat_with_pwav(entries: bytes) -> bytes:
    """Build a minimal ANLZ ``.DAT`` payload carrying one PWAV tag."""
    tag = b"PWAV" + struct.pack(">III", 20, 20 + len(entries), len(entries)) + struct.pack(">I", 0) + entries
    header = b"PMAI" + struct.pack(">II", 16, 16 + len(tag)) + struct.pack(">I", 0)
    return header + tag


@pytest.fixture
def device(tmp_path: Path) -> Path:
    """Create a temp USB tree with an encrypted exportLibrary.db + assets."""
    root = tmp_path / "USB"
    (root / "PIONEER" / "rekordbox").mkdir(parents=True)

    # Artwork the DB points at.
    art_dir = root / "PIONEER" / "Artwork" / "00001"
    art_dir.mkdir(parents=True)
    (art_dir / "b1.jpg").write_bytes(b"JPEGDATA")

    # ANLZ sidecar: .DAT referenced by the DB, PWV4 lives in the .EXT beside it.
    anlz_dir = root / "PIONEER" / "USBANLZ" / "P001" / "00000001"
    anlz_dir.mkdir(parents=True)
    pwv4 = bytes(range(12))  # 2 entries x 6 bytes
    (anlz_dir / "ANLZ0000.EXT").write_bytes(_anlz_ext_with_pwv4(pwv4))
    pwav = bytes(range(8))  # 8 single-byte columns
    (anlz_dir / "ANLZ0000.DAT").write_bytes(_anlz_dat_with_pwav(pwav))

    # The audio file track 10 points at.
    audio_dir = root / "Contents" / "BoC" / "Music"
    audio_dir.mkdir(parents=True)
    (audio_dir / "roygbiv.mp3").write_bytes(b"ID3fake-mp3-bytes")

    db_path = root / "PIONEER" / "rekordbox" / "exportLibrary.db"
    conn = sqlite.connect(str(db_path))
    conn.execute(f"PRAGMA key = '{_DEVICE_LIBRARY_KEY}'")
    conn.executescript(_SCHEMA)
    conn.executemany("INSERT INTO artist VALUES (?, ?)", [(1, "Boards of Canada"), (2, "")])
    conn.execute("INSERT INTO genre VALUES (1, 'Ambient')")
    conn.execute("INSERT INTO key VALUES (1, '8A')")
    conn.execute("INSERT INTO image VALUES (1, '/PIONEER/Artwork/00001/b1.jpg')")
    conn.executemany(
        "INSERT INTO content ("
        "content_id, title, bpmx100, length, path, djComment, dateAdded, releaseDate,"
        " image_id, analysisDataFilePath, artist_id_artist, album_id, genre_id, key_id) VALUES"
        " (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                10,
                "Roygbiv",
                12800,
                210,
                "/Contents/BoC/Music/roygbiv.mp3",
                "sc:42",
                "2025-01-02",
                "1998-06-01",
                1,
                "/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT",
                1,
                None,
                1,
                1,
            ),
            (
                11,
                "Olson",
                9000,
                90,
                "/Contents/BoC/Music/olson.mp3",
                "",
                "2025-02-03",
                "",
                None,
                None,
                1,
                None,
                1,
                None,
            ),
        ],
    )
    # Folder (attribute 1) at root, one playlist inside it with both tracks (reversed order).
    conn.executemany(
        "INSERT INTO playlist (playlist_id, sequenceNo, name, attribute, playlist_id_parent) VALUES (?, ?, ?, ?, ?)",
        [(100, 0, "My Folder", 1, 0), (101, 1, "Set A", 0, 100)],
    )
    conn.executemany(
        "INSERT INTO playlist_content (playlist_id, content_id, sequenceNo) VALUES (?, ?, ?)",
        [(101, 11, 0), (101, 10, 1)],
    )
    conn.commit()
    conn.close()
    return root


def test_unavailable_without_db(tmp_path: Path) -> None:
    src = UsbExportSource(tmp_path / "empty")
    assert src.is_available() is False
    with pytest.raises(RekordboxUnavailable):
        src.check_available()


def test_lists_tracks_with_resolved_metadata(device: Path) -> None:
    src = UsbExportSource(device)
    assert src.is_available() is True
    tracks = {t.id: t for t in src.list_all_tracks()}
    assert set(tracks) == {"10", "11"}

    roygbiv = tracks["10"]
    assert roygbiv.title == "Roygbiv"
    assert roygbiv.artist == "Boards of Canada"
    assert roygbiv.genre == "Ambient"
    assert roygbiv.key == "8A"
    assert roygbiv.bpm == 128.0
    assert roygbiv.duration_seconds == 210
    assert roygbiv.file_path == "/Contents/BoC/Music/roygbiv.mp3"
    assert roygbiv.soundcloud_id == 42  # parsed from the sc:<id> prefix
    assert roygbiv.date_added == "2025-01-02"
    assert roygbiv.release_date == "1998-06-01"
    assert roygbiv.has_artwork is True
    assert roygbiv.has_waveform is True

    # Empty strings / missing refs collapse to None.
    olson = tracks["11"]
    assert olson.album is None
    assert olson.key is None
    assert olson.release_date is None
    assert olson.soundcloud_id is None
    assert olson.has_artwork is False
    assert olson.has_waveform is False


def test_playlists_folder_hierarchy_and_counts(device: Path) -> None:
    src = UsbExportSource(device)
    playlists = {p.id: p for p in src.list_playlists()}
    folder = playlists["100"]
    leaf = playlists["101"]
    assert folder.is_folder is True
    assert folder.parent_id is None  # root sentinel 0 -> None
    assert folder.track_count == 0
    assert leaf.is_folder is False
    assert leaf.parent_id == "100"
    assert leaf.track_count == 2


def test_playlist_tracks_preserve_sequence(device: Path) -> None:
    src = UsbExportSource(device)
    ordered = src.list_playlist_tracks("101")
    # sequenceNo 0 -> content 11, then 1 -> content 10.
    assert [t.id for t in ordered] == ["11", "10"]


def test_artwork_and_waveform_bytes(device: Path) -> None:
    src = UsbExportSource(device)
    assert src.get_track_artwork("10") == b"JPEGDATA"
    assert src.get_track_artwork("11") is None  # no image
    assert src.get_track_waveform_preview("10") == bytes(range(12))
    assert src.get_track_waveform_preview("11") is None  # no analysis path
    assert src.get_track_waveform_blue("10") == bytes(range(8))
    assert src.get_track_waveform_blue("11") is None  # no analysis path


def test_audio_path_resolves_within_device(device: Path) -> None:
    src = UsbExportSource(device)
    path = src.get_track_audio_path("10")
    assert path is not None and path.is_file()
    assert path == (device / "Contents/BoC/Music/roygbiv.mp3")
    assert src.get_track_audio_path("11") is None  # file not on device


@pytest.fixture
def usb_client(device: Path, monkeypatch: pytest.MonkeyPatch):
    """A TestClient over the rekordbox router with the temp device discovered."""
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    from backend.api.rekordbox import router
    from backend.core.services import rekordbox as rb_service

    dev = rb_service.UsbDevice(id=str(device), label=device.name, mount_path=str(device))
    monkeypatch.setattr(rb_service, "discover_usb_devices", lambda: [dev])
    rb_service._usb_sources.clear()

    app = FastAPI()
    app.include_router(router)
    return TestClient(app), str(device)


def test_api_lists_devices(usb_client) -> None:
    client, dev_id = usb_client
    resp = client.get("/api/rekordbox/usb/devices")
    assert resp.status_code == 200
    devices = resp.json()["devices"]
    assert [d["id"] for d in devices] == [dev_id]


def test_api_playlists_and_audio_routed_to_device(usb_client) -> None:
    client, dev_id = usb_client

    playlists = client.get("/api/rekordbox/playlists", params={"device": dev_id})
    assert playlists.status_code == 200
    assert {p["id"] for p in playlists.json()["playlists"]} == {"100", "101"}

    audio = client.get("/api/rekordbox/tracks/10/audio", params={"device": dev_id})
    assert audio.status_code == 200
    assert audio.content == b"ID3fake-mp3-bytes"

    missing = client.get("/api/rekordbox/tracks/11/audio", params={"device": dev_id})
    assert missing.status_code == 404


def test_api_unknown_device_is_503(usb_client) -> None:
    client, _ = usb_client
    resp = client.get("/api/rekordbox/playlists", params={"device": "/nope"})
    assert resp.status_code == 503


def test_api_eject_success_forgets_cached_source(usb_client, monkeypatch) -> None:
    client, dev_id = usb_client
    from backend.core.services import rekordbox as rb_service

    calls: list[str] = []
    monkeypatch.setattr(rb_service, "eject_device", calls.append)
    rb_service.get_source(dev_id)  # warm the cache
    assert dev_id in rb_service._usb_sources

    resp = client.post("/api/rekordbox/usb/eject", params={"device": dev_id})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert calls == [dev_id]
    assert dev_id not in rb_service._usb_sources  # source dropped before unmount


def test_api_eject_busy_is_409(usb_client, monkeypatch) -> None:
    client, dev_id = usb_client
    from backend.core.services import rekordbox as rb_service

    def boom(_: str) -> None:
        raise rb_service.EjectError("Volume in use")

    monkeypatch.setattr(rb_service, "eject_device", boom)
    resp = client.post("/api/rekordbox/usb/eject", params={"device": dev_id})
    assert resp.status_code == 409
    assert "in use" in resp.json()["detail"]


def test_api_eject_unknown_device_is_404(usb_client) -> None:
    client, _ = usb_client
    resp = client.post("/api/rekordbox/usb/eject", params={"device": "/nope"})
    assert resp.status_code == 404


def test_eject_device_raises_on_nonzero_exit(monkeypatch) -> None:
    from backend.core.services.rekordbox import EjectError
    from backend.core.services.rekordbox import devices as dev_mod

    class _Result:
        returncode = 1
        stderr = "Unmount failed: busy"

    monkeypatch.setattr(dev_mod.subprocess, "run", lambda *a, **k: _Result())
    with pytest.raises(EjectError, match="busy"):
        dev_mod.eject_device("/Volumes/X")
