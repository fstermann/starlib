"""First-launch setup endpoint.

Reads and writes the user config file at the platform-appropriate path
(e.g. ~/Library/Application Support/starlib/config.env on macOS).
The soundcloud_tools Settings class is a pydantic-settings BaseSettings that picks up
variables from a .env file. We point it at the user config file via _env_file.
"""

import logging
import os
import stat

from fastapi import APIRouter, HTTPException, status
from platformdirs import user_config_path

from backend.config import get_backend_settings
from backend.schemas.setup import SetupRequest, SetupResponse, SetupStatusResponse
from soundcloud_tools.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/setup", tags=["setup"])

# Config file location: platform-appropriate config dir
_CONFIG_DIR = user_config_path("starlib", ensure_exists=True)
_CONFIG_FILE = _CONFIG_DIR / "config.env"


def _read_config() -> dict[str, str]:
    """Read key=value pairs from the user config file."""
    if not _CONFIG_FILE.exists():
        return {}
    result: dict[str, str] = {}
    for line in _CONFIG_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        result[key.strip()] = value.strip()
    return result


def _write_config(data: dict[str, str]) -> None:
    """Write key=value pairs to the user config file."""
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    lines = [f"{k}={v}" for k, v in data.items()]
    _CONFIG_FILE.write_text("\n".join(lines) + "\n")
    os.chmod(_CONFIG_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 0o600 — owner-only


@router.get("/status", response_model=SetupStatusResponse)
def get_setup_status() -> SetupStatusResponse:
    """Return whether the app has been configured with SoundCloud credentials.

    Returns
    -------
    SetupStatusResponse
        configured=True when both client_id and client_secret are present.
    """
    cfg = _read_config()
    configured = bool(cfg.get("CLIENT_ID") and cfg.get("CLIENT_SECRET"))
    return SetupStatusResponse(configured=configured)


@router.post("", response_model=SetupResponse)
def save_setup(body: SetupRequest) -> SetupResponse:
    """Persist SoundCloud credentials and music folder path entered during first-launch setup.

    Parameters
    ----------
    body : SetupRequest
        Credentials and folder path from the setup form.

    Returns
    -------
    SetupResponse
        Success confirmation.

    Raises
    ------
    HTTPException
        If saving the config file fails.
    """
    if not body.client_id or not body.client_secret:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="client_id and client_secret are required",
        )

    try:
        existing = _read_config()
        existing["CLIENT_ID"] = body.client_id
        existing["CLIENT_SECRET"] = body.client_secret
        existing["ROOT_MUSIC_FOLDER"] = body.root_music_folder
        _write_config(existing)
    except OSError as exc:
        logger.exception("Failed to write config file")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not write config",
        ) from exc

    # Invalidate the cached settings so the new values take effect immediately.
    get_settings.cache_clear()
    get_backend_settings.cache_clear()

    logger.info("Setup complete. Config written to %s", _CONFIG_FILE)
    return SetupResponse(success=True, message="Configuration saved successfully.")
