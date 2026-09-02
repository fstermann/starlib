"""Add ``duration_s`` to ``analyser_track_overrides``.

Lets the timeline render manual tracks with their actual length (sourced
from the SoundCloud track the user picked in the add dialog) instead of
falling back to the next-track-start heuristic.

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_track_overrides") as batch:
        batch.add_column(sa.Column("duration_s", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("analyser_track_overrides") as batch:
        batch.drop_column("duration_s")
