"""OAuth 2.1 Authorization Code Flow endpoints."""

import base64
import hashlib
import logging
import secrets
from urllib.parse import urlencode, urlparse

import requests
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import HTMLResponse

from backend.schemas.auth import (
    AuthorizeResponse,
    CallbackRequest,
    CallbackResponse,
    RefreshRequest,
    RefreshResponse,
    UserInfo,
)
from soundcloud_tools.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/soundcloud", tags=["authentication"])

# Allowed origins for return_to validation (open redirect protection)
_ALLOWED_RETURN_ORIGINS = frozenset(
    {
        "http://localhost:3000",
        "https://tauri.localhost",
        "tauri://localhost",
    }
)

# Server-side storage for pending OAuth flows: state -> (code_verifier, return_to)
_pending_oauth_flows: dict[str, tuple[str, str]] = {}

# Server-side storage for completed OAuth flows: state -> CallbackResponse
_completed_oauth_flows: dict[str, CallbackResponse] = {}


def _exchange_code(code: str, code_verifier: str) -> CallbackResponse:
    """Exchange an authorization code for tokens and fetch user info."""
    settings = get_settings()

    token_resp = requests.post(
        "https://secure.soundcloud.com/oauth/token",
        headers={
            "accept": "application/json; charset=utf-8",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "authorization_code",
            "client_id": settings.client_id,
            "client_secret": settings.client_secret,
            "redirect_uri": settings.soundcloud_redirect_uri,
            "code_verifier": code_verifier,
            "code": code,
        },
        timeout=10,
    )

    if not token_resp.ok:
        logger.error(
            "SoundCloud token exchange failed: status=%s body=%s",
            token_resp.status_code,
            token_resp.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud token exchange failed",
        )

    token_data = token_resp.json()
    logger.info("Token exchange success: scope=%s", token_data.get("scope"))

    me_resp = requests.get(
        "https://api.soundcloud.com/me",
        headers={
            "Authorization": f"OAuth {token_data['access_token']}",
            "accept": "application/json; charset=utf-8",
        },
        timeout=10,
    )

    if not me_resp.ok:
        logger.error(
            "Failed to fetch user info from SoundCloud: status=%s body=%s",
            me_resp.status_code,
            me_resp.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to fetch user info from SoundCloud",
        )

    user_data = me_resp.json()

    return CallbackResponse(
        access_token=token_data["access_token"],
        refresh_token=token_data.get("refresh_token"),
        expires_in=token_data.get("expires_in"),
        user=UserInfo(
            id=user_data["id"],
            username=user_data["username"],
            permalink=user_data["permalink"],
            avatar_url=user_data.get("avatar_url"),
        ),
    )


@router.get("/authorize", response_model=AuthorizeResponse)
def get_authorization_url(
    return_to: str = Query(default="http://localhost:3000/auth/soundcloud/callback"),
) -> AuthorizeResponse:
    """Build and return the SoundCloud authorization URL.

    The frontend should redirect the user to this URL.

    Parameters
    ----------
    return_to : str
        URL to redirect back to after OAuth completes.

    Returns
    -------
    AuthorizeResponse
        The authorization URL and CSRF state token.
    """
    settings = get_settings()

    # Validate return_to against allowlist (open redirect protection)
    parsed = urlparse(return_to)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in _ALLOWED_RETURN_ORIGINS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid return_to URL.",
        )

    state = secrets.token_urlsafe(16)

    # PKCE: generate code_verifier and derive code_challenge (S256)
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()

    params = {
        "client_id": settings.client_id,
        "redirect_uri": settings.soundcloud_redirect_uri,
        "response_type": "code",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }

    authorization_url = f"https://secure.soundcloud.com/authorize?{urlencode(params)}"

    # Store code_verifier and return_to server-side, keyed by state
    _pending_oauth_flows[state] = (code_verifier, return_to)

    return AuthorizeResponse(authorization_url=authorization_url, state=state)


_REDIRECT_HTML_TEMPLATE = """
<!DOCTYPE html>
<html><head><title>Redirecting\u2026</title>
<script>window.location.href = "{redirect_url}";</script>
</head><body><p>Redirecting\u2026 <a href="{redirect_url}">Click here</a> if not redirected.</p>
</body></html>
"""


@router.get("/redirect")
def handle_redirect(
    code: str = Query(...),
    state: str = Query(...),
) -> HTMLResponse:
    """Handle OAuth redirect from SoundCloud.

    SoundCloud redirects here with code and state. This endpoint exchanges
    the code for tokens, stores the result, and redirects the browser
    back to the frontend callback page.
    """
    flow_data = _pending_oauth_flows.pop(state, None)
    if flow_data is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired state parameter.",
        )

    code_verifier, return_to = flow_data
    result = _exchange_code(code, code_verifier)
    _completed_oauth_flows[state] = result

    # Build redirect URL back to frontend callback
    separator = "&" if "?" in return_to else "?"
    redirect_url = f"{return_to}{separator}state={state}"
    html = _REDIRECT_HTML_TEMPLATE.replace("{redirect_url}", redirect_url)
    return HTMLResponse(content=html)


@router.get("/result", response_model=CallbackResponse)
def get_oauth_result(state: str = Query(...)) -> CallbackResponse:
    """Retrieve completed OAuth result by state token.

    One-time retrieval: the result is removed after being fetched.
    """
    result = _completed_oauth_flows.pop(state, None)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No OAuth result found for this state.",
        )
    return result


@router.post("/callback", response_model=CallbackResponse)
def handle_callback(body: CallbackRequest) -> CallbackResponse:
    """Exchange authorization code for tokens and return user info.

    Parameters
    ----------
    body : CallbackRequest
        Authorization code and state from SoundCloud redirect.

    Returns
    -------
    CallbackResponse
        Access token, refresh token, and basic user info.

    Raises
    ------
    HTTPException
        If token exchange or user info fetch fails.
    """
    if not body.state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing state parameter.",
        )

    flow_data = _pending_oauth_flows.pop(body.state, None)
    if flow_data is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired state parameter.",
        )

    code_verifier, _ = flow_data
    return _exchange_code(body.code, code_verifier)


@router.post("/refresh", response_model=RefreshResponse)
def refresh_token(body: RefreshRequest) -> RefreshResponse:
    """Exchange a refresh token for a new access token.

    Parameters
    ----------
    body : RefreshRequest
        The refresh token.

    Returns
    -------
    RefreshResponse
        New access token and refresh token.

    Raises
    ------
    HTTPException
        If the refresh token is invalid or expired.
    """
    settings = get_settings()

    token_resp = requests.post(
        "https://secure.soundcloud.com/oauth/token",
        headers={
            "accept": "application/json; charset=utf-8",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "refresh_token",
            "client_id": settings.client_id,
            "client_secret": settings.client_secret,
            "refresh_token": body.refresh_token,
        },
        timeout=10,
    )

    if not token_resp.ok:
        logger.error(
            "SoundCloud token refresh failed: status=%s body=%s",
            token_resp.status_code,
            token_resp.text,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud token refresh failed",
        )

    token_data = token_resp.json()
    return RefreshResponse(
        access_token=token_data["access_token"],
        refresh_token=token_data.get("refresh_token"),
        expires_in=token_data.get("expires_in"),
    )
