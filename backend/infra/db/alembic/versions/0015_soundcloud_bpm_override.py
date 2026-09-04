"""Add soundcloud_bpm_override.

A user-set correction for an original SoundCloud track's tempo, applied in
the Set Analyser alignment dialog when detection got the BPM wrong (usually
a half/double-time octave error). Kept in its own table, separate from the
peaks cache (invalidated on re-decode) and the ``soundcloud_track_bpm``
detection cache (wiped by algorithm-bump migrations), so a manual correction
survives both. Presence of a row means the override wins over detection.

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-04
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "soundcloud_bpm_override",
        sa.Column("track_id", sa.Integer(), primary_key=True),
        sa.Column("bpm", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("soundcloud_bpm_override")
