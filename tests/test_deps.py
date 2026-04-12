"""Tests for backend API dependency functions."""

from pathlib import Path

import pytest
from fastapi import HTTPException

from backend.api.deps import validate_file_path, validate_folder_mode


class TestValidateFilePath:
    """Tests for the validate_file_path security function."""

    def test_valid_absolute_path(self, tmp_path: Path) -> None:
        """Absolute path within root is accepted."""
        f = tmp_path / "test.mp3"
        f.touch()
        result = validate_file_path(str(f), tmp_path)
        assert result == f.resolve()

    def test_valid_relative_path(self, tmp_path: Path) -> None:
        """Relative path resolved against root is accepted."""
        f = tmp_path / "test.mp3"
        f.touch()
        result = validate_file_path("test.mp3", tmp_path)
        assert result == f.resolve()

    def test_traversal_rejected(self, tmp_path: Path) -> None:
        """Directory traversal outside root is rejected with 403."""
        outside = tmp_path.parent / "secret.txt"
        outside.touch()
        with pytest.raises(HTTPException) as exc_info:
            validate_file_path(str(outside), tmp_path)
        assert exc_info.value.status_code == 403

    def test_relative_traversal_rejected(self, tmp_path: Path) -> None:
        """Relative directory traversal (../) is rejected."""
        (tmp_path.parent / "secret.txt").touch()
        with pytest.raises(HTTPException) as exc_info:
            validate_file_path("../secret.txt", tmp_path)
        assert exc_info.value.status_code == 403

    def test_nonexistent_file_rejected(self, tmp_path: Path) -> None:
        """Non-existent file within root is rejected with 404."""
        with pytest.raises(HTTPException) as exc_info:
            validate_file_path("nonexistent.mp3", tmp_path)
        assert exc_info.value.status_code == 404


class TestValidateFolderMode:
    """Tests for the validate_folder_mode function."""

    @pytest.mark.parametrize("mode", ["prepare", "collection", "cleaned", "inbox", "my-folder", "folder_2", ""])
    def test_valid_modes(self, mode: str) -> None:
        """Any alphanumeric/hyphen/underscore folder name is accepted."""
        assert validate_folder_mode(mode) == mode

    @pytest.mark.parametrize("mode", ["../etc", "foo/bar", "a b", "folder!"])
    def test_invalid_mode_rejected(self, mode: str) -> None:
        """Folder names with unsafe characters are rejected with 400."""
        with pytest.raises(HTTPException) as exc_info:
            validate_folder_mode(mode)
        assert exc_info.value.status_code == 400
