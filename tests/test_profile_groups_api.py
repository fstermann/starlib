"""Integration tests for the ProfileGroups REST API."""

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.profile_groups import router as profile_groups_router


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
    app.include_router(profile_groups_router)
    return TestClient(app)


def _member_payload(urn: str = "soundcloud:users:1", username: str = "alice") -> dict:
    return {
        "user_urn": urn,
        "permalink": username,
        "username": username,
        "avatar_url": None,
    }


# ---------------------------------------------------------------------------
# GET /api/profile-groups
# ---------------------------------------------------------------------------


def test_list_groups_empty_initially(api_client: TestClient) -> None:
    resp = api_client.get("/api/profile-groups")
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"groups": [], "active_group_id": ""}


# ---------------------------------------------------------------------------
# POST /api/profile-groups
# ---------------------------------------------------------------------------


def test_create_group(api_client: TestClient) -> None:
    payload = {"name": "DJs I follow", "members": [_member_payload()]}
    resp = api_client.post("/api/profile-groups", json=payload)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "DJs I follow"
    assert len(body["members"]) == 1
    assert body["id"]


def test_created_group_appears_in_list(api_client: TestClient) -> None:
    api_client.post("/api/profile-groups", json={"name": "G1", "members": []})
    resp = api_client.get("/api/profile-groups")
    assert any(g["name"] == "G1" for g in resp.json()["groups"])


# ---------------------------------------------------------------------------
# PUT /api/profile-groups/{id}
# ---------------------------------------------------------------------------


def test_update_group_name_and_members(api_client: TestClient) -> None:
    create = api_client.post(
        "/api/profile-groups",
        json={"name": "Initial", "members": []},
    )
    group_id = create.json()["id"]

    resp = api_client.put(
        f"/api/profile-groups/{group_id}",
        json={"name": "Renamed", "members": [_member_payload()]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Renamed"
    assert len(body["members"]) == 1


def test_update_missing_group_returns_404(api_client: TestClient) -> None:
    resp = api_client.put(
        "/api/profile-groups/does-not-exist",
        json={"name": "X"},
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /api/profile-groups/{id}
# ---------------------------------------------------------------------------


def test_delete_group(api_client: TestClient) -> None:
    create = api_client.post("/api/profile-groups", json={"name": "Bye", "members": []})
    group_id = create.json()["id"]

    resp = api_client.delete(f"/api/profile-groups/{group_id}")
    assert resp.status_code == 204

    listing = api_client.get("/api/profile-groups").json()
    assert all(g["id"] != group_id for g in listing["groups"])


def test_delete_missing_group_returns_404(api_client: TestClient) -> None:
    resp = api_client.delete("/api/profile-groups/ghost")
    assert resp.status_code == 404


def test_delete_active_group_clears_active(api_client: TestClient) -> None:
    create = api_client.post("/api/profile-groups", json={"name": "Active", "members": []})
    group_id = create.json()["id"]
    api_client.put(f"/api/profile-groups/{group_id}/activate")

    api_client.delete(f"/api/profile-groups/{group_id}")
    listing = api_client.get("/api/profile-groups").json()
    assert listing["active_group_id"] == ""


# ---------------------------------------------------------------------------
# PUT /api/profile-groups/{id}/activate + GET /active
# ---------------------------------------------------------------------------


def test_activate_group_persists(api_client: TestClient) -> None:
    create = api_client.post("/api/profile-groups", json={"name": "Pin me", "members": []})
    group_id = create.json()["id"]

    resp = api_client.put(f"/api/profile-groups/{group_id}/activate")
    assert resp.status_code == 200
    assert resp.json()["id"] == group_id

    active = api_client.get("/api/profile-groups/active")
    assert active.status_code == 200
    assert active.json()["id"] == group_id


def test_get_active_returns_null_when_unset(api_client: TestClient) -> None:
    resp = api_client.get("/api/profile-groups/active")
    assert resp.status_code == 200
    assert resp.json() is None


def test_activate_missing_group_returns_404(api_client: TestClient) -> None:
    resp = api_client.put("/api/profile-groups/ghost/activate")
    assert resp.status_code == 404
