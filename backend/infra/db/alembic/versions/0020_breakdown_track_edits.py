"""Add ``breakdown_track_edits`` for Track Breakdown section and grid edits.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-10
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "breakdown_track_edits",
        sa.Column("digest", sa.String(), primary_key=True),
        sa.Column("sections_json", sa.String(), nullable=True),
        sa.Column("bpm", sa.Float(), nullable=True),
        sa.Column("downbeat_s", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("breakdown_track_edits")
