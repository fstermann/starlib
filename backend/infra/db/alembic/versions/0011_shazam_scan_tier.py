"""Add tier column to analyser_shazam_scans.

Tiered Shazam scanning lets the user run progressively finer passes:
``sweep`` (60 s cadence) → ``refine`` (20 s) → ``pinpoint`` (8 s).
Each row records the tier it was produced under so the timeline can
prefer finer-tier matches over coarser ones at the same scan_s.

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_shazam_scans") as batch:
        batch.add_column(
            sa.Column(
                "tier",
                sa.String(),
                nullable=False,
                server_default="sweep",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("analyser_shazam_scans") as batch:
        batch.drop_column("tier")
