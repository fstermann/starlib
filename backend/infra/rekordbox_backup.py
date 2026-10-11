"""Timestamped copies of the Rekordbox ``master.db``, taken before Starlib edits it."""

from __future__ import annotations

import logging
import shutil
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

BACKUPS_TO_KEEP = 5


def backup_master_db(db_path: Path, backup_dir: Path, keep: int = BACKUPS_TO_KEEP) -> Path:
    """Copy ``master.db`` into a new timestamped folder under ``backup_dir``.

    A non-empty write-ahead log (``master.db-wal``) is copied alongside, since
    it may hold writes not yet merged into the database file. Only the newest
    ``keep`` backups are kept.

    Args:
        db_path: The ``master.db`` to copy.
        backup_dir: Folder holding one subfolder per backup.
        keep: How many backups to keep, newest first.

    Returns:
        Path: The new backup's folder.
    """
    dest = backup_dir / datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
    dest.mkdir(parents=True)
    shutil.copy2(db_path, dest / db_path.name)
    wal = db_path.with_name(f"{db_path.name}-wal")
    if wal.exists() and wal.stat().st_size > 0:
        shutil.copy2(wal, dest / wal.name)
    logger.info("backed up Rekordbox library to %s", dest)
    _prune(backup_dir, keep)
    return dest


def _prune(backup_dir: Path, keep: int) -> None:
    backups = sorted((p for p in backup_dir.iterdir() if p.is_dir()), reverse=True)
    for stale in backups[keep:]:
        shutil.rmtree(stale, ignore_errors=True)
