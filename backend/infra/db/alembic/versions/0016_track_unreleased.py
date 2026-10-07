"""Add unreleased to analyser_tracks.

Marks a track the user knows is unreleased, so it won't be on SoundCloud and
the tracklist export can say so.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-05
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.add_column(
            sa.Column(
                "unreleased",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.drop_column("unreleased")
