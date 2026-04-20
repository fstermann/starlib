"""Drop ``algorithm_version`` from ``soundcloud_track_bpm``.

The column was dropped from the model/schema after 0003 landed on dev
machines, but alembic only applies revisions once — installed DBs still
carry the column with its NOT NULL constraint, which breaks inserts from
the simplified ``upsert_sc_bpm`` helper. Rebuild the table without it.

Cache invalidation on future algorithm changes will be done by an explicit
``DELETE FROM soundcloud_track_bpm`` migration, not a per-row column.

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # SQLite doesn't support DROP COLUMN before 3.35; alembic's batch_alter_table
    # does the safe rebuild-and-swap dance under the hood.
    with op.batch_alter_table("soundcloud_track_bpm") as batch_op:
        batch_op.drop_column("algorithm_version")


def downgrade() -> None:
    # Re-add the column as nullable; data is not recoverable.
    with op.batch_alter_table("soundcloud_track_bpm") as batch_op:
        batch_op.add_column(sa.Column("algorithm_version", sa.Integer(), nullable=True))
