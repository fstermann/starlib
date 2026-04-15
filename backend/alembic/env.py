"""Alembic environment.

Invoked both from the CLI (``alembic revision --autogenerate``, ``alembic
check``) and programmatically from ``backend.core.db.migrations`` at app
startup.  The online path honours a pre-created Connection when the caller
puts one on ``config.attributes["connection"]``, so the same open engine can
drive the upgrade without opening a second SQLite handle.
"""

from __future__ import annotations

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlmodel import SQLModel

# Importing models registers every table on SQLModel.metadata.
from backend.core.db import models  # noqa: F401

config = context.config
target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting to a DB (used by --sql)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations with a live DB connection.

    If the caller already owns the connection (the common case when the
    backend boots), it lives under ``config.attributes["connection"]``;
    otherwise fall back to building one from ``sqlalchemy.url``.
    """
    existing_connection = config.attributes.get("connection")
    if existing_connection is not None:
        context.configure(
            connection=existing_connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()
        return

    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        future=True,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
