"""Record where SoundCloud tracks in the Track Breakdown recent list came from.

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-10
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("breakdown_track_history") as batch:
        batch.add_column(sa.Column("soundcloud_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("title", sa.String(), nullable=True))
        batch.add_column(sa.Column("artist", sa.String(), nullable=True))
        batch.add_column(sa.Column("artwork_url", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("breakdown_track_history") as batch:
        batch.drop_column("artwork_url")
        batch.drop_column("artist")
        batch.drop_column("title")
        batch.drop_column("soundcloud_id")
