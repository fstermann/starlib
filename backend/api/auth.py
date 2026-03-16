"""OAuth 2.1 Authorization Code Flow endpoints."""

import base64
import hashlib
import logging
import secrets
from urllib.parse import urlencode

import requests
from fastapi import APIRouter, HTTPException, status

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


@router.get("/authorize", response_model=AuthorizeResponse)
def get_authorization_url() -> AuthorizeResponse:
    """Build and return the SoundCloud authorization URL.

    The frontend should redirect the user to this URL.

    Returns
    -------
    AuthorizeResponse
        The authorization URL and CSRF state token.
    """
    settings = get_settings()

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
    return AuthorizeResponse(authorization_url=authorization_url, state=state, code_verifier=code_verifier)


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
    settings = get_settings()

    # Exchange code for tokens
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
            "code_verifier": body.code_verifier,
            "code": body.code,
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
            detail=f"SoundCloud token exchange failed: {token_resp.text}",
        )

    token_data = token_resp.json()
    logger.info("Token exchange success: scope=%s", token_data.get("scope"))

    # Fetch user info with the new token
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
            detail=f"SoundCloud token refresh failed: {token_resp.text}",
        )

    token_data = token_resp.json()
    return RefreshResponse(
        access_token=token_data["access_token"],
        refresh_token=token_data.get("refresh_token"),
        expires_in=token_data.get("expires_in"),
    )
