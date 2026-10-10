"""Set Breakdown service package (issue #403).

Public surface used by ``backend.api.breakdown``:

- :class:`BreakdownJobOptions`     — user-supplied analysis configuration.
- :func:`start_job`               — start a new analysis job.
- :func:`reanalyse_job`           — re-emit events for a sub-region.
- :func:`get_job_snapshot`        — load a finished/in-progress job for the
  reload / deep-link path.
- :func:`recent_jobs`             — list recent analyses for the home view.
- :func:`set_bpm_at`              — mix tempo at a track's position.
"""

from __future__ import annotations

from backend.services.breakdown.controller import (
    BreakdownJobOptions,
    JobNotFoundError,
    cancel_shazam_scan,
    delete_job,
    get_job_snapshot,
    reanalyse_job,
    recent_jobs,
    set_bpm_at,
    start_job,
    start_shazam_scan,
    subscribe_to_job,
)

__all__ = [
    "BreakdownJobOptions",
    "JobNotFoundError",
    "cancel_shazam_scan",
    "delete_job",
    "get_job_snapshot",
    "reanalyse_job",
    "recent_jobs",
    "set_bpm_at",
    "start_job",
    "start_shazam_scan",
    "subscribe_to_job",
]
