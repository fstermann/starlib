"""OS-keychain-backed storage for provider credentials.

Wraps the ``keyring`` library so we don't sprinkle its API across callers
and can no-op gracefully when no backend is available (e.g. headless CI).
"""

import logging

import keyring
from keyring.errors import KeyringError, NoKeyringError

logger = logging.getLogger(__name__)

_SERVICE = "starlib"
_ANTHROPIC_USERNAME = "anthropic_api_key"


def _safe_get(username: str) -> str | None:
    try:
        return keyring.get_password(_SERVICE, username)
    except (KeyringError, NoKeyringError) as exc:
        logger.warning("Keyring unavailable when reading %s: %s", username, exc)
        return None


def _safe_set(username: str, value: str) -> bool:
    try:
        keyring.set_password(_SERVICE, username, value)
        return True
    except (KeyringError, NoKeyringError) as exc:
        logger.warning("Keyring unavailable when writing %s: %s", username, exc)
        return False


def _safe_delete(username: str) -> bool:
    try:
        keyring.delete_password(_SERVICE, username)
        return True
    except keyring.errors.PasswordDeleteError:
        return False
    except (KeyringError, NoKeyringError) as exc:
        logger.warning("Keyring unavailable when deleting %s: %s", username, exc)
        return False


def get_anthropic_api_key() -> str | None:
    return _safe_get(_ANTHROPIC_USERNAME)


def set_anthropic_api_key(api_key: str) -> bool:
    return _safe_set(_ANTHROPIC_USERNAME, api_key)


def delete_anthropic_api_key() -> bool:
    return _safe_delete(_ANTHROPIC_USERNAME)


def has_anthropic_api_key() -> bool:
    return bool(get_anthropic_api_key())
