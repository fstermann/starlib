"""Wipe tracks cache for recursive folder indexing.

The ``folder`` column previously stored the top-level mode folder
(e.g. ``/Music/prepare``) for all tracks underneath it, regardless of
their actual parent directory.  It now stores the file's real parent
directory, and indexing is recursive.  All rows must be re-indexed.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-16
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM tracks")


def downgrade() -> None:
    # The old indexer would write different folder values, so a downgrade
    # also requires a full re-index.
    op.execute("DELETE FROM tracks")
