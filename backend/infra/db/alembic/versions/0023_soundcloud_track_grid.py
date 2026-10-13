"""Add soundcloud_track_grid.

Caches the beatgrid and phrases detected for a SoundCloud track, so a track
is downloaded and analysed once, not on every play. Wipe the table in a later
migration when the detection changes.

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-12
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "soundcloud_track_grid",
        sa.Column("track_id", sa.Integer(), primary_key=True),
        sa.Column("analysis", sa.Text(), nullable=False),
        sa.Column("analyzed_at", sa.Float(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("soundcloud_track_grid")
