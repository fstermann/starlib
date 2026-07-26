"""SQLAlchemy engine factory for the cache DB.

One module-level engine, configured for SQLite + WAL + concurrent reads.  The
WAL and ``synchronous=NORMAL`` pragmas are applied on every new pooled
connection via an event listener so the configuration survives pool recycles.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event

logger = logging.getLogger(__name__)

_engine: Engine | None = None
_engine_path: Path | None = None


def _install_pragmas(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()


def init_engine(db_path: Path) -> Engine:
    """Create (or replace) the module-level engine bound to *db_path*."""
    global _engine, _engine_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if _engine is not None:
        _engine.dispose()
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
        future=True,
    )
    _install_pragmas(engine)
    _engine = engine
    _engine_path = db_path
    logger.info("cache DB engine initialised at %s", db_path)
    return engine


def get_engine() -> Engine:
    if _engine is None:
        raise RuntimeError("cache DB engine not initialised — call init_engine() first")
    return _engine


def get_db_path() -> Path:
    if _engine_path is None:
        raise RuntimeError("cache DB engine not initialised")
    return _engine_path
