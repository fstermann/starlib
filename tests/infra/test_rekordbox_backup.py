"""Tests for the Rekordbox ``master.db`` backup helper."""

from __future__ import annotations

from pathlib import Path

from backend.infra.rekordbox_backup import backup_master_db


def _library(tmp_path: Path, wal: bytes = b"") -> Path:
    db = tmp_path / "rekordbox" / "master.db"
    db.parent.mkdir()
    db.write_bytes(b"db")
    (db.parent / "master.db-wal").write_bytes(wal)
    return db


def test_copies_the_database_and_a_non_empty_wal(tmp_path: Path) -> None:
    db = _library(tmp_path, wal=b"pending")

    dest = backup_master_db(db, tmp_path / "backups")

    assert (dest / "master.db").read_bytes() == b"db"
    assert (dest / "master.db-wal").read_bytes() == b"pending"


def test_skips_an_empty_wal(tmp_path: Path) -> None:
    dest = backup_master_db(_library(tmp_path), tmp_path / "backups")

    assert [p.name for p in dest.iterdir()] == ["master.db"]


def test_keeps_only_the_newest_backups(tmp_path: Path) -> None:
    db = _library(tmp_path)
    made = [backup_master_db(db, tmp_path / "backups", keep=2) for _ in range(4)]

    assert sorted((tmp_path / "backups").iterdir()) == made[-2:]
