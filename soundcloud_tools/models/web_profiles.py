from typing import Literal

from pydantic import BaseModel


class WebProfile(BaseModel):
    """User's external link profile from official API"""

    created_at: str  # Timestamp of when the link was added
    urn: str  # ID
    kind: Literal["web-profile"]
    service: str  # Service or platform (e.g., "facebook", "instagram")
    title: str  # Link's title
    url: str  # URL of the external link
    username: str | None = None  # Username extracted from the external link


WebProfiles = list[WebProfile]
