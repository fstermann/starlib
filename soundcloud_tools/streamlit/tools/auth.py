"""
OAuth Authentication page for Streamlit.

Uses the same localhost:8080 callback server pattern as get_user_tokens.py so
the browser redirect lands on our own server instead of Streamlit.  Tokens are
persisted to ~/.soundcloud_tools_tokens.json so every page reload and app
restart picks them up automatically — no session-state loss.
"""

import base64
import hashlib
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import requests
import streamlit as st
from streamlit import session_state as sst

from soundcloud_tools.settings import get_settings
from soundcloud_tools.streamlit.client import get_client
from soundcloud_tools.streamlit.token_store import (
    clear_tokens,
    get_token_mtime,
    read_tokens,
    write_tokens,
)

REDIRECT_URI = "http://localhost:8080/callback"

# ---------------------------------------------------------------------------
# Module-level server tracking (safe for single-user local app)
# ---------------------------------------------------------------------------
_server_lock = threading.Lock()
_active_server: HTTPServer | None = None


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


def _generate_pkce() -> tuple[str, str]:
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("utf-8").rstrip("=")
    code_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("utf-8")).digest()).decode("utf-8").rstrip("=")
    )
    return code_verifier, code_challenge


# ---------------------------------------------------------------------------
# Token exchange
# ---------------------------------------------------------------------------


def _exchange_code(code: str, code_verifier: str) -> dict:
    settings = get_settings()
    resp = requests.post(
        "https://secure.soundcloud.com/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": settings.effective_client_id,
            "client_secret": settings.effective_client_secret,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": code_verifier,
            "code": code,
        },
        headers={"accept": "application/json; charset=utf-8"},
        verify=False,
    )
    if resp.status_code == 200:
        return resp.json()
    raise RuntimeError(f"Token exchange failed: {resp.status_code} — {resp.text}")


# ---------------------------------------------------------------------------
# Callback HTTP server
# ---------------------------------------------------------------------------


def _make_handler(code_verifier: str):
    """Return a request-handler class that has code_verifier in its closure."""

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)

            if "code" in params:
                try:
                    tokens = _exchange_code(params["code"][0], code_verifier)
                    write_tokens(tokens["access_token"], tokens["refresh_token"])
                    body = b"""
                        <html>
                        <head><title>Authorised</title></head>
                        <body style="font-family:Arial;padding:50px;text-align:center">
                            <h1 style="color:green">&#10003; Authorisation successful!</h1>
                            <p>You can close this tab and return to the app.</p>
                        </body>
                        </html>
                    """
                    self._respond(200, body)
                except Exception as exc:
                    body = f"<html><body><h1 style='color:red'>Error</h1><p>{exc}</p></body></html>"
                    self._respond(500, body.encode())
            elif "error" in params:
                error = params["error"][0]
                body = f"<html><body><h1 style='color:red'>Authorisation denied</h1><p>{error}</p></body></html>"
                self._respond(200, body.encode())
            else:
                self._respond(400, b"<html><body><h1>No code received</h1></body></html>")

        def _respond(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):  # suppress access logs
            pass

    return _Handler


def _start_callback_server(code_verifier: str) -> None:
    """Start a one-shot HTTP server on port 8080 in a background thread."""
    global _active_server

    with _server_lock:
        # Shut down any previously running server first
        if _active_server is not None:
            try:
                _active_server.server_close()
            except Exception:
                pass
            _active_server = None

        server = HTTPServer(("localhost", 8080), _make_handler(code_verifier))
        _active_server = server

    # handle_request() blocks until exactly one request has been processed,
    # then returns — matching the pattern in get_user_tokens.py.
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# Launch the full OAuth flow
# ---------------------------------------------------------------------------


def _launch_oauth_flow() -> None:
    """Generate PKCE, spin up the callback server, open the browser."""
    code_verifier, code_challenge = _generate_pkce()
    settings = get_settings()

    auth_url = "https://secure.soundcloud.com/authorize?" + urlencode(
        {
            "client_id": settings.effective_client_id,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": secrets.token_urlsafe(16),
        }
    )

    # Record the token-file mtime *before* starting so we can detect when
    # fresh tokens have been written by the callback server.
    sst.auth_started_mtime = get_token_mtime()
    sst.auth_in_progress = True

    _start_callback_server(code_verifier)
    webbrowser.open(auth_url)
    st.rerun()


# ---------------------------------------------------------------------------
# Streamlit page
# ---------------------------------------------------------------------------


def main():
    st.header("🔐 SoundCloud Authentication")

    client = get_client()
    has_write_access = bool(client._refresh_token)

    st.write("Configure your SoundCloud authentication to enable playlist creation and other write operations.")
    st.divider()

    # ── Current status ────────────────────────────────────────────────────────
    st.subheader("Current Status")
    col1, col2, col3 = st.columns(3)
    with col1:
        if has_write_access:
            st.success("✓ User OAuth")
        else:
            st.warning("✗ No User OAuth")
    with col2:
        if client._access_token:
            st.success("✓ Access Token")
        else:
            st.warning("✗ No Access Token")
    with col3:
        if client._refresh_token:
            st.success("✓ Refresh Token")
        else:
            st.warning("✗ No Refresh Token")

    with st.expander("View Authentication Details"):
        st.json(client.get_auth_status())

    st.divider()

    # ── OAuth flow ────────────────────────────────────────────────────────────
    st.subheader("User OAuth Setup")

    # Polling state: waiting for the browser callback to complete
    if sst.get("auth_in_progress"):
        st.info(
            "🌐 A browser window has been opened — please authorise the app on SoundCloud "
            "and this page will update automatically."
        )

        current_mtime = get_token_mtime()
        if current_mtime > sst.get("auth_started_mtime", 0):
            # New tokens written by the callback server
            tokens = read_tokens()
            if tokens:
                client.apply_tokens(tokens["access_token"], tokens["refresh_token"])
                sst.auth_in_progress = False
                st.success("✅ Authentication successful! Tokens saved and applied.")
                st.rerun()

        col1, col2 = st.columns(2)
        with col1:
            if st.button("↻ Check now"):
                st.rerun()
        with col2:
            if st.button("✕ Cancel"):
                sst.auth_in_progress = False
                st.rerun()

        # Auto-poll every 2 seconds
        time.sleep(2)
        st.rerun()
        return

    # Normal (non-polling) state
    if has_write_access:
        st.success("✓ You're authenticated with user OAuth — playlist creation is enabled.")

        col1, col2 = st.columns(2)
        with col1:
            if st.button("🔄 Re-authenticate"):
                _launch_oauth_flow()
        with col2:
            if st.button("🗑 Clear Saved Tokens"):
                clear_tokens()
                client._refresh_token = None
                client._access_token = None
                st.rerun()
    else:
        st.info(
            "To create playlists and perform write operations you need to authenticate with your SoundCloud account."
        )
        if st.button("🚀 Authenticate with SoundCloud", type="primary"):
            _launch_oauth_flow()

    st.divider()

    with st.expander("📚 How it works"):
        st.markdown(f"""
        Clicking **Authenticate** will:

        1. Start a temporary HTTP server on `localhost:8080`
        2. Open your browser to the SoundCloud authorisation page
        3. After you click *Connect*, SoundCloud redirects to `{REDIRECT_URI}`
        4. The local server exchanges the code for tokens and saves them to
           `~/.soundcloud_tools_tokens.json`
        5. This page detects the new file and applies the tokens — no restart needed

        Tokens are loaded from the file on every app start, so you only need to
        authenticate once.
        """)


if __name__ == "__main__":
    main()
