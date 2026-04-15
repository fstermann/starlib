"""Database layer: SQLModel models, engine factory, Alembic bootstrap.

Public surface used by the rest of the backend is intentionally small:

- ``engine.get_engine()``   — lazily-initialised SQLAlchemy Engine.
- ``engine.init_engine()``  — called once from ``cache_db.init_db``.
- ``models.Track``, ``models.Peaks``.
- ``migrations.run_migrations(engine, db_path)`` — Alembic bootstrap.

Everything else stays an implementation detail of ``backend.core.services.cache_db``.
"""
