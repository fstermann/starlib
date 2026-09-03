"""Decouple Shazam from segmentation: drop track-per-section, add scan grid.

The original analyser pipeline tied Shazam recognition to the segmenter's
section boundaries — every section got one Shazam slice from its midpoint.
That conflates two unrelated concerns: novelty/timbre detection (the
segmenter's job) and "what track is playing at time T" (Shazam's job).
For DJ-mix material the segmenter is too coarse to be a useful query
schedule — one bad section means a 60-minute span with one Shazam attempt.

This migration drops ``analyser_track_ids`` (section-keyed cache) and
replaces it with ``analyser_shazam_scans``, a flat (job_id, scan_s,
pitch_offset) grid that the new scan stage walks at a fixed cadence
independent of section boundaries.

Revision ID: 0006
Revises: 0005
Create Date: 2026-04-30
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("analyser_track_ids")
    op.create_table(
        "analyser_shazam_scans",
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("scan_s", sa.Float(), nullable=False),
        sa.Column("pitch_offset", sa.Float(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("artist", sa.String(), nullable=True),
        sa.Column("shazam_id", sa.String(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("matched_at", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("job_id", "scan_s", "pitch_offset"),
    )
    op.create_index(
        "ix_analyser_shazam_scans_job_id",
        "analyser_shazam_scans",
        ["job_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_analyser_shazam_scans_job_id", table_name="analyser_shazam_scans")
    op.drop_table("analyser_shazam_scans")
    op.create_table(
        "analyser_track_ids",
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("section_index", sa.Integer(), nullable=False),
        sa.Column("pitch_offset", sa.Float(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("artist", sa.String(), nullable=True),
        sa.Column("shazam_id", sa.String(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("matched_at", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("job_id", "section_index", "pitch_offset"),
    )
