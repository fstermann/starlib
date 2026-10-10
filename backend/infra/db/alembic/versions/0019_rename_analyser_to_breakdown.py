"""Rename the ``analyser_*`` tables and indexes to ``breakdown_*``.

The Set Analyser feature is now Set Breakdown.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-10
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0019"
down_revision: str = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = ("jobs", "window_bpm", "sections", "shazam_scans", "tracks")

# (index suffix, table suffix, columns, unique, where clause)
_INDEXES = (
    ("jobs_soundcloud_id", "jobs", "soundcloud_id", False, ""),
    ("window_bpm_job_id", "window_bpm", "job_id", False, ""),
    ("shazam_scans_job_id", "shazam_scans", "job_id", False, ""),
    ("tracks_job_id", "tracks", "job_id", False, ""),
    ("tracks_job_shazam", "tracks", "job_id, shazam_id", True, "WHERE shazam_id IS NOT NULL"),
)


def _rename(old: str, new: str) -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {old}_{table} RENAME TO {new}_{table}")
    for name, table, columns, unique, where in _INDEXES:
        op.execute(f"DROP INDEX ix_{old}_{name}")
        op.execute(f"CREATE {'UNIQUE ' if unique else ''}INDEX ix_{new}_{name} ON {new}_{table} ({columns}) {where}")


def upgrade() -> None:
    _rename("analyser", "breakdown")


def downgrade() -> None:
    _rename("breakdown", "analyser")
