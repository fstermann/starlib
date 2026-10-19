"""Let a Set Breakdown job analyse a local audio file instead of a SoundCloud set.

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-18
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
    with op.batch_alter_table("breakdown_jobs") as batch:
        batch.add_column(sa.Column("local_path", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("breakdown_jobs") as batch:
        batch.drop_column("local_path")
