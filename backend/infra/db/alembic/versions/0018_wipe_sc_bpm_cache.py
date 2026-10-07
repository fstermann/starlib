"""Wipe the cached SoundCloud BPMs.

Mixes and playlist picks used to load tracks without SoundCloud's listed BPM,
so the player detected and cached one instead. The cache outranks the listed
value in the UI, so clear it. User corrections in ``soundcloud_bpm_override``
are kept.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-07
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0018"
down_revision: str = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM soundcloud_track_bpm")


def downgrade() -> None:
    # The wiped rows can't come back; the cache refills on demand.
    pass
