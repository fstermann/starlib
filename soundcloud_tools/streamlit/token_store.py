"""
Persistent token storage for the Streamlit app.

Tokens are written to a file in the user's home directory so they survive
Streamlit reruns and page navigations without losing session state.
"""

import json
import os
from pathlib import Path

TOKEN_FILE = Path(os.environ.get("SOUNDCLOUD_TOKEN_FILE", str(Path.home() / ".soundcloud_tools_tokens.json")))


def write_tokens(access_token: str, refresh_token: str) -> None:
    """Persist OAuth tokens to the token file."""
    TOKEN_FILE.write_text(
        json.dumps({"access_token": access_token, "refresh_token": refresh_token})
    )


def read_tokens() -> dict | None:
    """Read OAuth tokens from the token file. Returns None if the file doesn't exist or is invalid."""
    if not TOKEN_FILE.exists():
        return None
    try:
        data = json.loads(TOKEN_FILE.read_text())
        if data.get("access_token"):
            return data
    except Exception:
        pass
    return None


def clear_tokens() -> None:
    """Delete the token file."""
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()


def get_token_mtime() -> float:
    """Return the modification timestamp of the token file, or 0.0 if it doesn't exist."""
    if TOKEN_FILE.exists():
        return TOKEN_FILE.stat().st_mtime
    return 0.0
