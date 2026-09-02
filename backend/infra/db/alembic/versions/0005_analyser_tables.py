"""Tables for the Set Analyser feature (#403).

Adds four tables that let an analyser job — driven by the
``starlib_audio::analyser-stream`` CLI subprocess — persist its output so
the user can leave and return without re-analysing:

- ``analyser_jobs``: one row per analysed set; remembers the SoundCloud id,
  user-supplied analysis options, status, and timing.
- ``analyser_window_bpm``: chunked BPM results streamed by the analyser
  during stage 1 (one row per window).
- ``analyser_sections``: detected section boundaries from stage 2; refined
  by per-region re-analysis.
- ``analyser_track_ids``: Shazam matches per section; cached by
  ``(job_id, section_index, pitch_offset)`` so re-analyses with identical
  parameters don't re-spend the Shazam budget.

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-30
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "analyser_jobs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("soundcloud_id", sa.Integer(), nullable=True),
        sa.Column("source_url", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("artist", sa.String(), nullable=True),
        sa.Column("duration_s", sa.Float(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        # Stored options as JSON so we can iterate without migrations.
        sa.Column("options_json", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.Float(), nullable=False),
    )
    op.create_index(
        "ix_analyser_jobs_soundcloud_id",
        "analyser_jobs",
        ["soundcloud_id"],
    )

    op.create_table(
        "analyser_window_bpm",
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("start_s", sa.Float(), nullable=False),
        sa.Column("end_s", sa.Float(), nullable=False),
        sa.Column("bpm", sa.Float(), nullable=False),
        sa.Column("confidence", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("job_id", "start_s"),
    )
    op.create_index(
        "ix_analyser_window_bpm_job_id",
        "analyser_window_bpm",
        ["job_id"],
    )

    op.create_table(
        "analyser_sections",
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("section_index", sa.Integer(), nullable=False),
        sa.Column("start_s", sa.Float(), nullable=False),
        sa.Column("end_s", sa.Float(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("job_id", "section_index"),
    )

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


def downgrade() -> None:
    op.drop_table("analyser_track_ids")
    op.drop_table("analyser_sections")
    op.drop_index("ix_analyser_window_bpm_job_id", table_name="analyser_window_bpm")
    op.drop_table("analyser_window_bpm")
    op.drop_index("ix_analyser_jobs_soundcloud_id", table_name="analyser_jobs")
    op.drop_table("analyser_jobs")
