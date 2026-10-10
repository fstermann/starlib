"""Setting up stem separation from the app, with the installer faked."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.breakdown_stems import router
from backend.infra.breakdown import demucs_env
from backend.services.breakdown import stem_setup


@pytest.fixture(autouse=True)
def _fake_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[dict]:
    control: dict = {"release": None, "fail": False}
    marker = tmp_path / "installed"

    async def fake_install(on_stage) -> None:
        on_stage("packages")
        if control["release"] is not None:
            await control["release"].wait()
        if control["fail"]:
            raise demucs_env.InstallError("uv failed: no network")
        marker.touch()

    monkeypatch.setattr(demucs_env, "install", fake_install)
    monkeypatch.setattr(demucs_env, "is_installed", marker.exists)
    monkeypatch.setattr(demucs_env, "size_bytes", lambda: 832 * 2**20)
    monkeypatch.setattr(demucs_env, "remove", lambda: marker.unlink(missing_ok=True))
    monkeypatch.setattr(stem_setup, "_task", None)
    monkeypatch.setattr(stem_setup, "_error", None)
    yield control


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as c:
        yield c


def _wait_for(client: TestClient, status: str) -> dict:
    for _ in range(100):
        body = client.get("/api/breakdown/stem-separation").json()
        if body["status"] == status:
            return body
        time.sleep(0.01)
    raise AssertionError(f"never reached {status}: {body}")


def test_install_reports_progress_then_ready(client: TestClient, _fake_install: dict) -> None:
    assert client.get("/api/breakdown/stem-separation").json()["status"] == "missing"
    _fake_install["release"] = asyncio.Event()

    started = client.post("/api/breakdown/stem-separation/install").json()
    assert started["status"] == "installing"
    assert _wait_for(client, "installing")["stage"] == "packages"

    client.portal.call(_fake_install["release"].set)  # type: ignore[union-attr]
    assert _wait_for(client, "ready")["size_bytes"] == 832 * 2**20


def test_failed_install_reports_the_error(client: TestClient, _fake_install: dict) -> None:
    _fake_install["fail"] = True
    client.post("/api/breakdown/stem-separation/install")

    assert _wait_for(client, "error")["error"] == "uv failed: no network"


def test_remove_frees_the_install(client: TestClient) -> None:
    client.post("/api/breakdown/stem-separation/install")
    _wait_for(client, "ready")

    assert client.delete("/api/breakdown/stem-separation").json()["status"] == "missing"
