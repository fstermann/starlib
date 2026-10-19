"""Set Breakdown over a local audio file: starting a job, CUE import and loudness."""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import breakdown as breakdown_api
from backend.domain.tags import StarlibMeta
from backend.infra.breakdown import db as breakdown_db
from backend.infra.breakdown import loudness as meter
from backend.infra.db import engine as db_engine
from backend.infra.db.migrations import run_migrations
from backend.services.breakdown import controller as breakdown_controller
from backend.services.breakdown import cue_import, soundcloud_links

CUE = b"""PERFORMER "DJ"
TITLE "Set"
FILE "set.wav" WAVE
  TRACK 01 AUDIO
    TITLE "First"
    PERFORMER "A"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Second"
    PERFORMER "B"
    INDEX 01 00:30:00
"""


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    db_path = tmp_path / "breakdown.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    breakdown_controller._jobs.clear()
    monkeypatch.setattr(meter, "get_backend_settings", lambda: SimpleNamespace(cache_dir=tmp_path / "cache"))
    # Offline: a CUE import would otherwise search SoundCloud with the developer's own login.
    monkeypatch.setattr(soundcloud_links, "_token", lambda: None)
    yield
    engine.dispose()


@pytest.fixture()
def http_client() -> TestClient:
    app = FastAPI()
    app.include_router(breakdown_api.router)
    return TestClient(app)


def _seed_local_job(path: Path, job_id: str = "local-1", duration_s: float | None = 60.0) -> str:
    breakdown_db.insert_job(
        job_id=job_id,
        soundcloud_id=None,
        local_path=str(path),
        source_url=None,
        title="Set",
        artist=None,
        duration_s=duration_s,
        options={},
    )
    return job_id


def _tone(path: Path) -> Path:
    """60 s stereo tone: the first 30 s 6 dB louder than the rest."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    assert ffmpeg is not None
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=60:sample_rate=48000",
            "-af",
            "volume='if(lt(t,30),0.5,0.25)':eval=frame",
            "-ac",
            "2",
            "-y",
            str(path),
        ],
        check=True,
    )
    return path


def test_start_local_job_uses_file_name_as_title(
    http_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "Friday Set.wav"
    audio.write_bytes(b"RIFF")
    seen: dict[str, Any] = {}

    async def fake_start_job(**kwargs: Any) -> str:
        seen.update(kwargs)
        return "job-x"

    monkeypatch.setattr(breakdown_api, "start_job", fake_start_job)
    res = http_client.post("/api/breakdown/sets", json={"local_path": str(audio)})

    assert res.status_code == 200, res.text
    assert res.json() == {"job_id": "job-x"}
    assert seen["local_path"] == str(audio)
    assert seen["title"] == "Friday Set"
    assert "soundcloud_id" not in seen


def test_start_local_job_rejects_missing_and_non_audio_files(http_client: TestClient, tmp_path: Path) -> None:
    missing = http_client.post("/api/breakdown/sets", json={"local_path": str(tmp_path / "nope.wav")})
    assert missing.status_code == 404

    text = tmp_path / "notes.txt"
    text.write_text("hi")
    wrong = http_client.post("/api/breakdown/sets", json={"local_path": str(text)})
    assert wrong.status_code == 422


def test_local_job_serves_its_file_and_lists_its_path(http_client: TestClient, tmp_path: Path) -> None:
    audio = tmp_path / "set.wav"
    audio.write_bytes(b"RIFF....WAVE")
    job_id = _seed_local_job(audio)

    res = http_client.get(f"/api/breakdown/sets/{job_id}/audio")
    assert res.status_code == 200
    assert res.content == b"RIFF....WAVE"

    jobs = http_client.get("/api/breakdown/sets").json()["jobs"]
    assert jobs[0]["local_path"] == str(audio)


def test_moved_local_file_is_not_found(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(tmp_path / "gone.wav")

    assert http_client.get(f"/api/breakdown/sets/{job_id}/audio").status_code == 404
    assert http_client.post(f"/api/breakdown/sets/{job_id}/loudness").status_code == 404


def test_import_cue_replaces_tracklist_with_confirmed_tracks(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")
    breakdown_db.insert_track(job_id=job_id, origin="manual", start_s=10.0, title="Old")

    res = http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", CUE, "application/octet-stream")},
    )

    assert res.status_code == 200, res.text
    assert res.json()["imported"] == 2
    timeline = http_client.get(f"/api/breakdown/sets/{job_id}").json()["timeline"]
    assert [(t["title"], t["artist"], t["start_s"], t["end_s"]) for t in timeline] == [
        ("First", "A", 0.0, 30.0),
        ("Second", "B", 30.0, 60.0),
    ]
    assert all(t["confirmed"] for t in timeline)


def test_import_cue_links_soundcloud_from_the_tracks_source_files(
    http_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")
    tagged = {"/lib/a.aiff": StarlibMeta(soundcloud_id=111, soundcloud_permalink="https://soundcloud.com/a/first")}
    monkeypatch.setattr(cue_import, "read_starlib_meta", lambda path: tagged.get(str(path)))
    sheet = (
        b'REM RECORDED_BY "rekordbox-dj"\n'
        b'TRACK 01 AUDIO\n TITLE "First"\n FILE "/lib/a.aiff" WAVE\n INDEX 01 00:00:00\n'
        b'TRACK 02 AUDIO\n TITLE "Untagged"\n FILE "/lib/b.aiff" WAVE\n INDEX 01 00:00:30\n'
    )

    http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", sheet, "application/octet-stream")},
    )

    timeline = http_client.get(f"/api/breakdown/sets/{job_id}").json()["timeline"]
    assert [(t["start_s"], t["soundcloud_id"], t["soundcloud_permalink_url"]) for t in timeline] == [
        (0.0, 111, "https://soundcloud.com/a/first"),
        (30.0, None, None),
    ]


REPEATS = (
    b'TRACK 01 AUDIO\n TITLE "First"\n PERFORMER "A"\n INDEX 01 00:00:00\n'
    b'TRACK 02 AUDIO\n TITLE "Second"\n PERFORMER "B"\n INDEX 01 00:10:00\n'
    b'TRACK 03 AUDIO\n TITLE "First"\n PERFORMER "A"\n INDEX 01 00:20:00\n'
    b'TRACK 04 AUDIO\n TITLE "Third"\n PERFORMER "C"\n INDEX 01 00:30:00\n'
)


def test_import_cue_skips_repeated_entries_by_default(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")

    res = http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", REPEATS, "application/octet-stream")},
    )

    assert res.json() == {"job_id": job_id, "imported": 3, "skipped": 1, "linked": 0}
    timeline = http_client.get(f"/api/breakdown/sets/{job_id}").json()["timeline"]
    # The repeat's time goes to the track before it.
    assert [(t["title"], t["start_s"], t["end_s"]) for t in timeline] == [
        ("First", 0.0, 10.0),
        ("Second", 10.0, 30.0),
        ("Third", 30.0, 60.0),
    ]


def test_import_cue_can_keep_repeated_entries(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")

    res = http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", REPEATS, "application/octet-stream")},
        data={"skip_repeats": "false"},
    )

    assert res.json()["imported"] == 4
    assert res.json()["skipped"] == 0


def test_import_cue_fetches_artwork_and_length_of_linked_tracks(
    http_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")
    tagged = {"/lib/a.aiff": StarlibMeta(soundcloud_id=111, soundcloud_permalink="https://soundcloud.com/a/first")}
    monkeypatch.setattr(cue_import, "read_starlib_meta", lambda path: tagged.get(str(path)))
    monkeypatch.setattr(soundcloud_links, "_token", lambda: "token")
    fetched: list[int] = []

    async def get_track(track_id: int, *, token: str) -> dict:
        fetched.append(track_id)
        return {"id": track_id, "duration": 245_000, "artwork_url": "https://i1.sndcdn.com/a-large.jpg"}

    async def search_tracks(query: str, *, token: str) -> list[dict]:
        return []

    monkeypatch.setattr(soundcloud_links.client, "get_track", get_track)
    monkeypatch.setattr(soundcloud_links.client, "search_tracks", search_tracks)
    sheet = (
        b'REM RECORDED_BY "rekordbox-dj"\n'
        b'TRACK 01 AUDIO\n TITLE "First"\n FILE "/lib/a.aiff" WAVE\n INDEX 01 00:00:00\n'
    )

    res = http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", sheet, "application/octet-stream")},
    )

    assert res.json()["linked"] == 1
    assert fetched == [111]
    [track] = http_client.get(f"/api/breakdown/sets/{job_id}").json()["timeline"]
    assert track["artwork_url"] == "https://i1.sndcdn.com/a-large.jpg"
    assert track["duration_s"] == 245.0


def test_import_cue_takes_the_length_from_the_library_file_not_a_preview(
    http_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")
    library_file = _tone(tmp_path / "rr3.wav")
    preview_only = tmp_path / "missing.aiff"
    tagged = {
        str(library_file): StarlibMeta(soundcloud_id=1, soundcloud_permalink="https://soundcloud.com/a/rr3"),
        str(preview_only): StarlibMeta(soundcloud_id=2, soundcloud_permalink="https://soundcloud.com/a/go-plus"),
    }
    monkeypatch.setattr(cue_import, "read_starlib_meta", lambda path: tagged.get(str(path)))
    monkeypatch.setattr(soundcloud_links, "_token", lambda: "token")

    async def get_track(track_id: int, *, token: str) -> dict:
        # A Go+ upload only streams a 30 s snippet, and reports its length.
        return {"id": track_id, "duration": 30_000, "access": "preview", "artwork_url": "https://i1.sndcdn.com/x.jpg"}

    monkeypatch.setattr(soundcloud_links.client, "get_track", get_track)
    sheet = (
        f'TRACK 01 AUDIO\n TITLE "RR3"\n FILE "{library_file}" WAVE\n INDEX 01 00:00:00\n'
        f'TRACK 02 AUDIO\n TITLE "Go+"\n FILE "{preview_only}" WAVE\n INDEX 01 00:30:00\n'
    ).encode()

    http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", sheet, "application/octet-stream")},
    )

    timeline = http_client.get(f"/api/breakdown/sets/{job_id}").json()["timeline"]
    assert timeline[0]["duration_s"] == pytest.approx(60.0, abs=0.1)
    assert timeline[1]["duration_s"] is None
    assert timeline[1]["artwork_url"] == "https://i1.sndcdn.com/x.jpg"


def test_import_cue_rejects_a_sheet_without_tracks(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")

    res = http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", b'TITLE "x"\n', "application/octet-stream")},
    )

    assert res.status_code == 422


def test_loudness_is_measured_once_then_read_back_per_track(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(_tone(tmp_path / "set.wav"))
    http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", CUE, "application/octet-stream")},
    )
    assert http_client.get(f"/api/breakdown/sets/{job_id}/loudness").json() == {"report": None}
    assert http_client.get(f"/api/breakdown/sets/{job_id}/loudness/progress").json() == {"progress": None}

    report = http_client.post(f"/api/breakdown/sets/{job_id}/loudness").json()["report"]

    assert report["curve"]["step_s"] == 1.0
    assert len(report["curve"]["short_term_lufs"]) == pytest.approx(60, abs=1)
    assert report["short_term_max_lufs"] - report["short_term_min_lufs"] == pytest.approx(6.0, abs=0.2)
    first, second = report["segments"]
    assert first["label"] == "A - First"
    assert first["integrated_lufs"] - second["integrated_lufs"] == pytest.approx(6.0, abs=0.2)
    # Two tracks: the median sits midway, so each is 3 dB off it.
    assert first["suggested_gain_db"] == pytest.approx(-3.0, abs=0.1)
    assert second["suggested_gain_db"] == pytest.approx(3.0, abs=0.1)
    # A pure tone has no bass below the low band's cutoff.
    assert first["low_end_lu"] < -30
    assert report["low_end_reference_lu"] is not None
    # The level drops 6 dB right at the change.
    [change] = report["transitions"]
    assert change["at_s"] == 30.0
    assert (change["from_label"], change["to_label"]) == ("A - First", "B - Second")
    assert change["jump_lu"] == pytest.approx(-6.0, abs=0.2)
    peaks = report["curve"]["true_peak_dbtp"]
    assert len(peaks) == len(report["curve"]["short_term_lufs"])
    assert max(peaks) == pytest.approx(report["true_peak_dbtp"], abs=0.1)
    # The tone is 1 kHz: all its power sits in the mid band and the curve peaks there.
    bands = {band["name"]: band["level_db"] for band in report["bands"]}
    assert list(bands) == ["Sub", "Bass", "Low mid", "Mid", "High mid", "Air"]
    assert bands["Mid"] == pytest.approx(0.0, abs=0.1)
    spectrum = report["spectrum"]
    assert len(spectrum["centres_hz"]) == len(spectrum["level_db"]) == 60
    loudest = spectrum["centres_hz"][spectrum["level_db"].index(max(spectrum["level_db"]))]
    assert 900 < loudest < 1100
    assert http_client.get(f"/api/breakdown/sets/{job_id}/loudness").json()["report"] == report


def test_loudness_without_tracklist_suggests_nothing(http_client: TestClient, tmp_path: Path) -> None:
    # Detected sections don't line up with track changes, so they aren't levelled.
    job_id = _seed_local_job(_tone(tmp_path / "set.wav"))
    breakdown_db.insert_sections(
        job_id,
        [breakdown_db.SectionRow(section_index=0, start_s=0, end_s=30, confidence=1.0)],
    )

    report = http_client.post(f"/api/breakdown/sets/{job_id}/loudness").json()["report"]

    assert report["integrated_lufs"] is not None
    assert report["segments"] == []
    assert report["reference_lufs"] is None
    assert report["transitions"] == []


def test_linking_again_counts_only_tracks_that_gained_details(
    http_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _seed_local_job(tmp_path / "set.wav")
    tagged = {"/lib/a.aiff": StarlibMeta(soundcloud_id=111, soundcloud_permalink="https://soundcloud.com/a/first")}
    monkeypatch.setattr(cue_import, "read_starlib_meta", lambda path: tagged.get(str(path)))
    monkeypatch.setattr(soundcloud_links, "_token", lambda: "token")

    async def get_track(track_id: int, *, token: str) -> dict:
        # A preview-only upload without artwork: nothing to fill in.
        return {"id": track_id, "duration": 30_000, "access": "preview", "artwork_url": None}

    monkeypatch.setattr(soundcloud_links.client, "get_track", get_track)
    sheet = b'TRACK 01 AUDIO\n TITLE "First"\n FILE "/lib/a.aiff" WAVE\n INDEX 01 00:00:00\n'

    imported = http_client.post(
        f"/api/breakdown/sets/{job_id}/tracks/import-cue",
        files={"file": ("set.cue", sheet, "application/octet-stream")},
    ).json()
    relinked = http_client.post(f"/api/breakdown/sets/{job_id}/tracks/link-soundcloud").json()

    assert imported["linked"] == 0
    assert relinked["linked"] == 0


def test_loudness_segments_skip_tracks_below_min_matches(http_client: TestClient, tmp_path: Path) -> None:
    job_id = _seed_local_job(_tone(tmp_path / "set.wav"))
    breakdown_db.insert_track(job_id=job_id, origin="manual", start_s=0.0, title="Mine")
    breakdown_db.insert_track(job_id=job_id, origin="shazam", start_s=30.0, title="Guess", shazam_id="s1")
    breakdown_db.upsert_shazam_scan(
        job_id=job_id, scan_s=40.0, pitch_offset=0.0, title="Guess", artist=None, shazam_id="s1", confidence=1.0
    )
    url = f"/api/breakdown/sets/{job_id}/loudness"

    all_tracks = http_client.post(url).json()["report"]
    shown = http_client.get(url, params={"min_matches": 2}).json()["report"]

    assert [s["start_s"] for s in all_tracks["segments"]] == [0.0, 30.0]
    assert [(s["start_s"], s["end_s"]) for s in shown["segments"]] == [(0.0, 60.0)]
