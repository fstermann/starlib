"""Tests for the keyring-backed credentials service."""

from unittest.mock import patch

import keyring.errors

from backend.core.services import credentials


class TestAnthropicKey:
    def test_get_returns_stored_value(self) -> None:
        with patch("backend.core.services.credentials.keyring.get_password", return_value="sk-ant-xxx"):
            assert credentials.get_anthropic_api_key() == "sk-ant-xxx"

    def test_get_returns_none_when_keyring_missing(self) -> None:
        with patch(
            "backend.core.services.credentials.keyring.get_password",
            side_effect=keyring.errors.NoKeyringError("no backend"),
        ):
            assert credentials.get_anthropic_api_key() is None

    def test_set_returns_true_on_success(self) -> None:
        with patch("backend.core.services.credentials.keyring.set_password") as mock_set:
            assert credentials.set_anthropic_api_key("sk-ant-xxx") is True
            mock_set.assert_called_once_with("starlib", "anthropic_api_key", "sk-ant-xxx")

    def test_set_returns_false_when_keyring_missing(self) -> None:
        with patch(
            "backend.core.services.credentials.keyring.set_password",
            side_effect=keyring.errors.NoKeyringError("no backend"),
        ):
            assert credentials.set_anthropic_api_key("sk-ant-xxx") is False

    def test_delete_ignores_missing_entry(self) -> None:
        with patch(
            "backend.core.services.credentials.keyring.delete_password",
            side_effect=keyring.errors.PasswordDeleteError("not found"),
        ):
            assert credentials.delete_anthropic_api_key() is False

    def test_has_key_reflects_presence(self) -> None:
        with patch("backend.core.services.credentials.keyring.get_password", return_value="sk-ant-xxx"):
            assert credentials.has_anthropic_api_key() is True
        with patch("backend.core.services.credentials.keyring.get_password", return_value=None):
            assert credentials.has_anthropic_api_key() is False
