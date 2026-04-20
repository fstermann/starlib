"""Cache table for SoundCloud-track BPM results.

Analysis happens in the Rust/Tauri layer; this table holds the persisted
output so we don't reanalyze on every library view.

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "soundcloud_track_bpm",
        sa.Column("track_id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("bpm", sa.Integer(), nullable=False),
        sa.Column("algorithm_version", sa.Integer(), nullable=False),
        sa.Column("analyzed_at", sa.Float(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("soundcloud_track_bpm")
