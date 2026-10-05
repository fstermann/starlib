"""Add mix_in_s and mix_out_s to analyser_tracks.

Where a track is audible in the mix, from the alignment. ``start_s`` is where
the original's 0:00 lands, which for a track mixed in partway sits before it
is heard, and ``end_s`` is only the last Shazam hit.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-05
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# One batch per column: two in one batch trip SQLAlchemy's column-order sort
# when it rebuilds the table.


def upgrade() -> None:
    for column in ("mix_in_s", "mix_out_s"):
        with op.batch_alter_table("analyser_tracks") as batch:
            batch.add_column(sa.Column(column, sa.Float(), nullable=True))


def downgrade() -> None:
    for column in ("mix_out_s", "mix_in_s"):
        with op.batch_alter_table("analyser_tracks") as batch:
            batch.drop_column(column)
