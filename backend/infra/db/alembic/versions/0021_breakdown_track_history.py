"""Add ``breakdown_track_history`` for the Track Breakdown recent list.

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-10
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "breakdown_track_history",
        sa.Column("digest", sa.String(), primary_key=True),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("bpm", sa.Float(), nullable=False),
        sa.Column("root", sa.String(), nullable=True),
        sa.Column("n_bars", sa.Integer(), nullable=False),
        sa.Column("duration_s", sa.Float(), nullable=False),
        sa.Column("opened_at", sa.Float(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("breakdown_track_history")
