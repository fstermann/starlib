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
    calls: dict[str, Any] = {"measure_grids": [], "separate_delay": 0.0}

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
    assert client.get(f"/api/breakdown/tracks/{DIGEST}/stems/kazoo").status_code == 404


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
