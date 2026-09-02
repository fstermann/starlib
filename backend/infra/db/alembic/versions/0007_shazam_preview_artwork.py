"""Add preview_url + artwork_url to analyser_shazam_scans.

Shazam's recogniser returns a 30 s preview audio URL and a cover-art
URL alongside the match metadata. We previously discarded both — this
migration captures them so the analyser UI can play a preview clip and
show per-match artwork.

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_shazam_scans") as batch:
        batch.add_column(sa.Column("preview_url", sa.String(), nullable=True))
        batch.add_column(sa.Column("artwork_url", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("analyser_shazam_scans") as batch:
        batch.drop_column("artwork_url")
        batch.drop_column("preview_url")
