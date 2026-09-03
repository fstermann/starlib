"""Add set_bpm + pitch_offset to analyser_tracks.

Tracks the mix tempo at the matched scan point and the semitone offset
applied to produce the Shazam match. Together they let the frontend
display ``set_bpm → estimated_original_bpm`` and adjust shown duration
to account for the DJ's pitch fader.

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.add_column(sa.Column("set_bpm", sa.Float(), nullable=True))
        batch.add_column(sa.Column("pitch_offset", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.drop_column("pitch_offset")
        batch.drop_column("set_bpm")
