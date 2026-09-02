"""Replace the override-overlay model with a single mutable tracklist table.

The previous model glued ``analyser_shazam_scans`` (immutable cache) and
``analyser_track_overrides`` (hide + manual rows) together at read time
inside ``_merged_timeline``. That worked but left identity fuzzy:
hides were matched by ``(start_s, shazam_id)`` and edits created two
rows that briefly shared ``(start, title)`` with the original — driving
React-key duplicates, special-case grouping, and "explicit end vs auto
end" carve-outs in the renderer.

This migration adds ``analyser_tracks`` and drops
``analyser_track_overrides``. From now on:

- The Shazam scan cache stays as-is (still in ``analyser_shazam_scans``).
- After every scan, aggregated runs are materialised into rows in this
  table (origin='shazam'). User edits flip ``user_edited`` so a re-scan
  doesn't overwrite them; deletes flip ``dismissed`` so a re-scan
  doesn't re-add them.
- All edits are direct CRUD on this table.

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "analyser_tracks",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),  # 'shazam' | 'manual'
        sa.Column("start_s", sa.Float(), nullable=False),
        sa.Column("end_s", sa.Float(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("artist", sa.String(), nullable=True),
        sa.Column("shazam_id", sa.String(), nullable=True),
        sa.Column("soundcloud_id", sa.Integer(), nullable=True),
        sa.Column("soundcloud_permalink_url", sa.String(), nullable=True),
        sa.Column("artwork_url", sa.String(), nullable=True),
        sa.Column("duration_s", sa.Float(), nullable=True),
        sa.Column("confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("dismissed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("user_edited", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
    )
    op.create_index(
        "ix_analyser_tracks_job_id",
        "analyser_tracks",
        ["job_id"],
    )
    # Partial unique index on (job_id, shazam_id) so the Shazam→tracks
    # sync can use it as an idempotency key without clobbering manual
    # rows (which carry shazam_id IS NULL).
    op.execute(
        "CREATE UNIQUE INDEX ix_analyser_tracks_job_shazam "
        "ON analyser_tracks (job_id, shazam_id) WHERE shazam_id IS NOT NULL"
    )
    op.drop_table("analyser_track_overrides")


def downgrade() -> None:
    op.create_table(
        "analyser_track_overrides",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("start_s", sa.Float(), nullable=False),
        sa.Column("end_s", sa.Float(), nullable=True),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("artist", sa.String(), nullable=True),
        sa.Column("shazam_id", sa.String(), nullable=True),
        sa.Column("soundcloud_id", sa.Integer(), nullable=True),
        sa.Column("soundcloud_permalink_url", sa.String(), nullable=True),
        sa.Column("artwork_url", sa.String(), nullable=True),
        sa.Column("duration_s", sa.Float(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    op.create_index(
        "ix_analyser_track_overrides_job_id",
        "analyser_track_overrides",
        ["job_id"],
    )
    op.execute("DROP INDEX IF EXISTS ix_analyser_tracks_job_shazam")
    op.drop_index("ix_analyser_tracks_job_id", table_name="analyser_tracks")
    op.drop_table("analyser_tracks")
