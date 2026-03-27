"""Schemas for first-launch setup and app configuration."""

from pydantic import BaseModel


class SetupStatusResponse(BaseModel):
    """Indicates whether the app has been configured."""

    configured: bool
    """True when client_id and client_secret are present in the user config."""


class SetupRequest(BaseModel):
    """Payload from the first-launch setup form."""

    client_id: str
    client_secret: str
    root_music_folder: str = "~/Music/tracks"


class SetupResponse(BaseModel):
    """Result of saving setup configuration."""

    success: bool
    message: str
