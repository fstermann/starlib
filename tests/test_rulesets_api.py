"""Integration tests for the rulesets REST API."""

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.rulesets import router as rulesets_router
from backend.core.services import ruleset as svc

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def patched_paths(tmp_path: Path):
    """Redirect the consolidated settings file to a temp directory."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
    ):
        yield config_dir


@pytest.fixture
def api_client(patched_paths) -> TestClient:
    app = FastAPI()
    app.include_router(rulesets_router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# GET /api/rulesets
# ---------------------------------------------------------------------------


def test_list_rulesets_returns_classic(api_client: TestClient) -> None:
    resp = api_client.get("/api/rulesets")
    assert resp.status_code == 200
    data = resp.json()
    assert "rulesets" in data
    ids = [r["id"] for r in data["rulesets"]]
    assert svc.CLASSIC_RULESET_ID in ids


def test_list_rulesets_includes_active_id(api_client: TestClient) -> None:
    resp = api_client.get("/api/rulesets")
    assert resp.status_code == 200
    assert "active_ruleset_id" in resp.json()


# ---------------------------------------------------------------------------
# GET /api/rulesets/active
# ---------------------------------------------------------------------------


def test_get_active_returns_classic_by_default(api_client: TestClient) -> None:
    resp = api_client.get("/api/rulesets/active")
    assert resp.status_code == 200
    assert resp.json()["id"] == svc.CLASSIC_RULESET_ID


# ---------------------------------------------------------------------------
# POST /api/rulesets
# ---------------------------------------------------------------------------


def test_create_ruleset(api_client: TestClient) -> None:
    payload = {
        "name": "My Workflow",
        "rules": [
            {"id": "r1", "type": "move", "input": "source", "params": {"folder": "cleaned"}},
        ],
    }
    resp = api_client.post("/api/rulesets", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "My Workflow"
    assert data["is_builtin"] is False
    assert data["id"]
    assert data["rules"][0]["input"] == "source"


def test_create_ruleset_appears_in_list(api_client: TestClient) -> None:
    api_client.post("/api/rulesets", json={"name": "New", "rules": []})
    resp = api_client.get("/api/rulesets")
    names = [r["name"] for r in resp.json()["rulesets"]]
    assert "New" in names


# ---------------------------------------------------------------------------
# PUT /api/rulesets/{id}
# ---------------------------------------------------------------------------


def test_update_ruleset(api_client: TestClient) -> None:
    created = api_client.post("/api/rulesets", json={"name": "Original", "rules": []}).json()
    resp = api_client.put(f"/api/rulesets/{created['id']}", json={"name": "Renamed"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"


def test_update_builtin_returns_403(api_client: TestClient) -> None:
    resp = api_client.put(f"/api/rulesets/{svc.CLASSIC_RULESET_ID}", json={"name": "Hack"})
    assert resp.status_code == 403


def test_update_missing_returns_404(api_client: TestClient) -> None:
    resp = api_client.put("/api/rulesets/ghost-id", json={"name": "X"})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /api/rulesets/{id}
# ---------------------------------------------------------------------------


def test_delete_ruleset(api_client: TestClient) -> None:
    created = api_client.post("/api/rulesets", json={"name": "Temp", "rules": []}).json()
    resp = api_client.delete(f"/api/rulesets/{created['id']}")
    assert resp.status_code == 204

    ids = [r["id"] for r in api_client.get("/api/rulesets").json()["rulesets"]]
    assert created["id"] not in ids


def test_delete_builtin_returns_403(api_client: TestClient) -> None:
    resp = api_client.delete(f"/api/rulesets/{svc.CLASSIC_RULESET_ID}")
    assert resp.status_code == 403


def test_delete_missing_returns_404(api_client: TestClient) -> None:
    resp = api_client.delete("/api/rulesets/no-such")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PUT /api/rulesets/{id}/activate
# ---------------------------------------------------------------------------


def test_activate_ruleset(api_client: TestClient) -> None:
    created = api_client.post("/api/rulesets", json={"name": "Alt", "rules": []}).json()
    resp = api_client.put(f"/api/rulesets/{created['id']}/activate")
    assert resp.status_code == 200
    assert resp.json()["id"] == created["id"]

    active = api_client.get("/api/rulesets/active").json()
    assert active["id"] == created["id"]


def test_activate_missing_returns_404(api_client: TestClient) -> None:
    resp = api_client.put("/api/rulesets/ghost-id/activate")
    assert resp.status_code == 404
