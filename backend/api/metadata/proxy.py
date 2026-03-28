"""Image proxy for SoundCloud CDN."""

from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Response, status

router = APIRouter()

_ALLOWED_SC_HOSTS = {"i1.sndcdn.com", "i2.sndcdn.com", "i3.sndcdn.com", "i4.sndcdn.com"}


@router.get("/proxy-image")
def proxy_image(url: str) -> Response:
    """Proxy an image from an allowed SoundCloud CDN host."""
    parsed = urlparse(url)
    if parsed.hostname not in _ALLOWED_SC_HOSTS or parsed.scheme != "https":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL not allowed")
    try:
        r = httpx.get(url, timeout=10, follow_redirects=True)
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to fetch image") from e
    return Response(content=r.content, media_type=r.headers.get("content-type", "image/jpeg"))
