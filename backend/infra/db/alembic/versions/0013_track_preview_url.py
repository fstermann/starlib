"""Add preview_url to analyser_tracks.

Shazam preview clips used to be looked up from the raw scan grid at
render time, but scan rows are a cache that finer-tier re-probes
overwrite — a re-probe that misses replaces a matched row and the
preview silently disappears from the tracklist. Persisting the URL on
the materialised track row survives re-scans.

Revision ID: 0013
Revises: 0012
Create Date: 2026-06-10
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.add_column(sa.Column("preview_url", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("analyser_tracks") as batch:
        batch.drop_column("preview_url")
