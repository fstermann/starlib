"""Add analyser_track_overrides for user-edited tracklists.

Lets users hide wrongly-matched Shazam runs and add manually-found tracks
(typically by linking a SoundCloud track) on top of the analyser's
auto-derived tracklist.

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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
        sa.Column("created_at", sa.Float(), nullable=False),
    )
    op.create_index(
        "ix_analyser_track_overrides_job_id",
        "analyser_track_overrides",
        ["job_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_analyser_track_overrides_job_id",
        table_name="analyser_track_overrides",
    )
    op.drop_table("analyser_track_overrides")
