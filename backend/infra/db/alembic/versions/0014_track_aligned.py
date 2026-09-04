"""Add aligned to analyser_tracks.

A higher user-curation tier than ``confirmed``: the user verified the
track's start alignment, not just its identity. ``aligned`` implies
``confirmed``.

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-04
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.add_column(
            sa.Column(
                "aligned",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.drop_column("aligned")
