"""Track Breakdown jobs, results, edits and stems over HTTP.

Hashing, Demucs and the Rust binary are replaced by fakes that write a
synthetic features document, so these tests run without audio tooling.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.breakdown_tracks import router
from backend.api.deps import get_root_folder
from backend.infra.breakdown import stems as stems_infra
from backend.infra.breakdown import track as track_infra
from backend.infra.db import engine as db_engine
from backend.infra.db.migrations import run_migrations
from backend.services.breakdown import track as track_service

DIGEST = "abc123"
SILENT = -70.0


def _bar(kick: float, bass: float, mix: float, width: float = 0.02) -> dict[str, Any]:
    return {"kick": kick, "bass": bass, "mix": mix, "width": width}


def make_features(bars: list[dict[str, Any]], *, grid: tuple[float, float] | None = None) -> dict[str, Any]:
    """Build a features document shaped like ``analyser-stream breakdown`` output."""
    n = len(bars)

    def source(levels: list[float], kick: list[float] | None = None) -> dict[str, Any]:
        return {
            "db": levels,
            "bands_db": [
                [k if kick else lvl, lvl, lvl, lvl, lvl, -18.0] for lvl, k in zip(levels, kick or levels, strict=True)
            ],
            "centroid_hz": [4000.0] * n,
            "width": [b["width"] for b in bars],
            "onset": [0.1] * n,
        }

    bpm, downbeat_s = grid or (128.0, 0.0)
    return {
        "pipeline_version": track_service.PIPELINE_VERSION,
        "sample_rate": 44100,
        "duration_s": n * 240 / bpm,
        "grid": {
            "bpm": bpm,
            "bpm_rough": bpm,
            "concentration": None if grid else 0.1,
            "downbeat_s": downbeat_s,
            "bar_s": 240 / bpm,
            "n_bars": n,
            "beats_per_bar": 4,
        },
        "bands_hz": [[20, 60], [60, 150], [150, 500], [500, 2000], [2000, 6000], [6000, 20000]],
        "sources": {
            "mix": source([b["mix"] for b in bars]),
            "drums": source([-6.0 if b["kick"] > SILENT else SILENT for b in bars], kick=[b["kick"] for b in bars]),
            "bass": source([b["bass"] for b in bars]),
            "other": source([-20.0] * n),
        },
        "groove": {},
        "tonal": {"root": "A", "bass_peaks": [], "chroma": [[0.0] * 12] * n},
    }


ARRANGEMENT = [_bar(-11, SILENT, -2.5)] * 16 + [_bar(-11, -5, -0.5)] * 16 + [_bar(SILENT, SILENT, -11, 0.6)] * 16


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    engine = db_engine.init_engine(tmp_path / "db.sqlite")
    run_migrations(engine, tmp_path / "db.sqlite")
    track_service._jobs.clear()
    calls: dict[str, Any] = {"measure_grids": [], "separate_delay": 0.0, "drum_splits": 0}

    async def fake_hash(_path: Path) -> str:
        return DIGEST

    async def fake_separate(_audio: Path, stems_dir: Path, on_progress) -> dict[str, Path]:
        on_progress(0.5)
        await asyncio.sleep(calls["separate_delay"])
        stems_dir.mkdir(parents=True, exist_ok=True)
        paths = {name: stems_dir / f"{name}.flac" for name in stems_infra.STEM_NAMES}
        for p in paths.values():
            p.write_bytes(b"fLaC")
        return paths

    async def fake_separate_drums(_drums: Path, stems_dir: Path, on_progress) -> dict[str, Path]:
        calls["drum_splits"] += 1
        on_progress(1.0)
        paths = {name: stems_dir / f"{name}.flac" for name in stems_infra.DRUM_PART_NAMES}
        for p in paths.values():
            p.write_bytes(b"fLaC")
        return paths

    async def fake_measure(_mix, _stems, out: Path, on_stage, grid=None) -> dict[str, Any]:
        calls["measure_grids"].append(grid)
        on_stage("mix")
        features = make_features(ARRANGEMENT, grid=grid)
        out.write_text(json.dumps(features))
        return features

    monkeypatch.setattr(track_infra, "audio_hash", fake_hash)
    monkeypatch.setattr(track_infra, "track_dir", lambda digest: tmp_path / "tracks" / digest)
    monkeypatch.setattr(track_infra, "measure", fake_measure)
    monkeypatch.setattr(stems_infra, "separate", fake_separate)
    monkeypatch.setattr(stems_infra, "separate_drums", fake_separate_drums)
    yield calls
    engine.dispose()


@pytest.fixture()
def music(tmp_path: Path) -> Path:
    root = tmp_path / "music"
    root.mkdir()
    (root / "track.aiff").write_bytes(b"audio")
    return root


@pytest.fixture()
def client(music: Path) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_root_folder] = lambda: music
    with TestClient(app) as c:
        yield c


def _events(client: TestClient, job_id: str) -> list[dict[str, Any]]:
    body = client.get(f"/api/breakdown/tracks/jobs/{job_id}/events").text
    return [json.loads(line.removeprefix("data: ")) for line in body.splitlines() if line.startswith("data: ")]


def _analyse(client: TestClient, music: Path) -> list[dict[str, Any]]:
    job_id = client.post("/api/breakdown/tracks/jobs", json={"path": str(music / "track.aiff")}).json()["job_id"]
    return _events(client, job_id)


def test_job_streams_progress_then_completes(client: TestClient, music: Path) -> None:
    events = _analyse(client, music)

    stages = [(e["stage"], e["progress"]) for e in events if e["type"] == "stage"]
    assert stages[:3] == [("hash", None), ("stems", 0.0), ("stems", 0.5)]
    assert events[-1] == {"type": "complete", "digest": DIGEST}


def test_result_has_detected_sections(client: TestClient, music: Path) -> None:
    _analyse(client, music)

    body = client.get(f"/api/breakdown/tracks/{DIGEST}").json()
    assert [(s["start_bar"], s["end_bar"], s["label"]) for s in body["sections"]] == [
        (1, 16, "intro"),
        (17, 32, "groove"),
        (33, 48, "breakdown"),
    ]
    assert body["sections_edited"] is False


def test_second_run_reuses_cached_features(client: TestClient, music: Path, _isolated: dict[str, Any]) -> None:
    _analyse(client, music)
    events = _analyse(client, music)

    assert [e["stage"] for e in events if e["type"] == "stage"] == ["hash"]
    assert len(_isolated["measure_grids"]) == 1


def test_section_edits_persist_and_reset(client: TestClient, music: Path) -> None:
    _analyse(client, music)
    edited = [
        {"start_bar": 1, "end_bar": 32, "label": "intro"},
        {"start_bar": 33, "end_bar": 48, "label": "breakdown"},
    ]

    assert client.put(f"/api/breakdown/tracks/{DIGEST}/sections", json={"sections": edited}).status_code == 200
    body = client.get(f"/api/breakdown/tracks/{DIGEST}").json()
    assert body["sections"] == edited
    assert body["sections_edited"] is True

    reset = client.delete(f"/api/breakdown/tracks/{DIGEST}/sections").json()
    assert reset["sections_edited"] is False
    assert len(reset["sections"]) == 3


def test_sections_with_a_gap_are_rejected(client: TestClient, music: Path) -> None:
    _analyse(client, music)
    gap = [{"start_bar": 1, "end_bar": 10, "label": "intro"}, {"start_bar": 12, "end_bar": 48, "label": "main"}]

    response = client.put(f"/api/breakdown/tracks/{DIGEST}/sections", json={"sections": gap})

    assert response.status_code == 422


def test_grid_edit_remeasures_on_the_next_job(client: TestClient, music: Path, _isolated: dict[str, Any]) -> None:
    _analyse(client, music)

    assert client.put(f"/api/breakdown/tracks/{DIGEST}/grid", json={"bpm": 130, "downbeat_s": 0.5}).status_code == 204
    _analyse(client, music)

    assert _isolated["measure_grids"] == [None, (130.0, 0.5)]
    assert client.get(f"/api/breakdown/tracks/{DIGEST}").json()["grid_edited"] is True


def test_cancel_stops_a_running_job(client: TestClient, music: Path, _isolated: dict[str, Any]) -> None:
    _isolated["separate_delay"] = 30.0
    job_id = client.post("/api/breakdown/tracks/jobs", json={"path": str(music / "track.aiff")}).json()["job_id"]

    assert client.post(f"/api/breakdown/tracks/jobs/{job_id}/cancel").json() == {"cancelled": True}
    assert _events(client, job_id)[-1] == {"type": "cancelled"}


def test_stems_are_served_once_analysed(client: TestClient, music: Path) -> None:
    assert client.get(f"/api/breakdown/tracks/{DIGEST}/stems/drums").status_code == 404
    _analyse(client, music)

    response = client.get(f"/api/breakdown/tracks/{DIGEST}/stems/drums")
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/flac"
    assert client.get(f"/api/breakdown/tracks/{DIGEST}/stems/kick").status_code == 200
    assert client.get(f"/api/breakdown/tracks/{DIGEST}/stems/kazoo").status_code == 404


def test_tracks_measured_before_drum_parts_get_them_next_time(
    client: TestClient, music: Path, tmp_path: Path, _isolated: dict[str, Any]
) -> None:
    _analyse(client, music)
    for part in ("kick", "snare", "hats"):
        (tmp_path / "tracks" / DIGEST / "stems" / f"{part}.flac").unlink()

    events = _analyse(client, music)

    assert [e["stage"] for e in events if e["type"] == "stage"] == ["hash", "drum_parts", "drum_parts"]
    assert len(_isolated["measure_grids"]) == 1
    assert _isolated["drum_splits"] == 2


def test_paths_outside_the_music_folder_are_refused(client: TestClient, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere.aiff"
    outside.write_bytes(b"audio")

    response = client.post("/api/breakdown/tracks/jobs", json={"path": str(outside)})

    assert response.status_code >= 400


def test_unanalysed_track_is_not_found(client: TestClient) -> None:
    assert client.get("/api/breakdown/tracks/unknown").status_code == 404


def test_analysed_tracks_are_listed_as_recent(client: TestClient, music: Path) -> None:
    assert client.get("/api/breakdown/tracks").json() == {"tracks": []}
    _analyse(client, music)

    [track] = client.get("/api/breakdown/tracks").json()["tracks"]
    assert track["digest"] == DIGEST
    assert track["path"] == str(music / "track.aiff")
    assert (track["bpm"], track["root"], track["n_bars"], track["missing"]) == (128.0, "A", 48, False)

    (music / "track.aiff").unlink()
    assert client.get("/api/breakdown/tracks").json()["tracks"][0]["missing"] is True


def test_delete_removes_stems_edits_and_recent_entry(client: TestClient, music: Path) -> None:
    _analyse(client, music)
    client.put(f"/api/breakdown/tracks/{DIGEST}/grid", json={"bpm": 130, "downbeat_s": 0.5})

    assert client.delete(f"/api/breakdown/tracks/{DIGEST}").status_code == 204

    assert client.get("/api/breakdown/tracks").json() == {"tracks": []}
    assert client.get(f"/api/breakdown/tracks/{DIGEST}").status_code == 404
    _analyse(client, music)
    assert client.get(f"/api/breakdown/tracks/{DIGEST}").json()["grid_edited"] is False


SC_ID = 42


@pytest.fixture()
def soundcloud(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Fake SoundCloud download into ``tmp_path``; counts downloads and can fail."""
    from backend.api import breakdown_tracks

    state: dict[str, Any] = {"downloads": 0, "fail": False}
    audio = tmp_path / "sets" / f"{SC_ID}.mp4"

    async def fake_download(track_id: int) -> tuple[Path, track_service.SoundCloudTrack]:
        if state["fail"]:
            raise RuntimeError("ffmpeg HLS download failed")
        state["downloads"] += 1
        audio.parent.mkdir(exist_ok=True)
        audio.write_bytes(b"aac")
        return audio, track_service.SoundCloudTrack(
            id=track_id, title="Tune", artist="Artist", artwork_url="https://i1.sndcdn.com/a.jpg"
        )

    monkeypatch.setattr(breakdown_tracks, "_download_soundcloud", fake_download)
    monkeypatch.setattr(
        breakdown_tracks.audio_cache, "cached_set_path", lambda track_id: audio if audio.exists() else None
    )
    return state


def _analyse_soundcloud(client: TestClient) -> list[dict[str, Any]]:
    job_id = client.post("/api/breakdown/tracks/jobs", json={"soundcloud_id": SC_ID}).json()["job_id"]
    return _events(client, job_id)


def test_soundcloud_track_downloads_then_analyses(client: TestClient, soundcloud: dict[str, Any]) -> None:
    events = _analyse_soundcloud(client)

    assert events[0] == {"type": "stage", "stage": "download", "progress": None}
    assert events[-1] == {"type": "complete", "digest": DIGEST}
    assert soundcloud["downloads"] == 1
    result = client.get(f"/api/breakdown/tracks/{DIGEST}").json()
    assert result["soundcloud"] == {
        "id": SC_ID,
        "title": "Tune",
        "artist": "Artist",
        "artwork_url": "https://i1.sndcdn.com/a.jpg",
    }
    assert client.get(f"/api/breakdown/tracks/soundcloud/{SC_ID}/audio").content == b"aac"


def test_soundcloud_track_is_listed_as_recent_and_never_missing(
    client: TestClient, soundcloud: dict[str, Any], tmp_path: Path
) -> None:
    _analyse_soundcloud(client)
    (tmp_path / "sets" / f"{SC_ID}.mp4").unlink()

    [track] = client.get("/api/breakdown/tracks").json()["tracks"]
    assert (track["soundcloud_id"], track["title"], track["artist"]) == (SC_ID, "Tune", "Artist")
    assert track["missing"] is False
    assert client.get(f"/api/breakdown/tracks/soundcloud/{SC_ID}/audio").status_code == 404


def test_soundcloud_download_failure_is_reported(client: TestClient, soundcloud: dict[str, Any]) -> None:
    soundcloud["fail"] = True

    event = _analyse_soundcloud(client)[-1]

    assert event["type"] == "error"
    assert event["message"].startswith("Couldn't download the track from SoundCloud")


def test_local_file_result_has_no_soundcloud_track(client: TestClient, music: Path) -> None:
    _analyse(client, music)

    assert client.get(f"/api/breakdown/tracks/{DIGEST}").json()["soundcloud"] is None


def test_job_needs_exactly_one_source(client: TestClient, music: Path) -> None:
    assert client.post("/api/breakdown/tracks/jobs", json={}).status_code == 422
    both = {"path": str(music / "track.aiff"), "soundcloud_id": SC_ID}
    assert client.post("/api/breakdown/tracks/jobs", json=both).status_code == 422
