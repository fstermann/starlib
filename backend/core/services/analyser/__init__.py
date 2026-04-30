"""Set Analyser service package (issue #403).

Public surface used by ``backend.api.analyser``:

- :class:`AnalyserJobOptions`     — user-supplied analysis configuration.
- :func:`start_job`               — start a new analysis job.
- :func:`reanalyse_job`           — re-emit events for a sub-region.
- :func:`get_job_snapshot`        — load a finished/in-progress job for the
  reload / deep-link path.
- :func:`recent_jobs`             — list recent analyses for the home view.
"""

from __future__ import annotations

from backend.core.services.analyser.controller import (
    AnalyserJobOptions,
    JobNotFoundError,
    get_job_snapshot,
    recent_jobs,
    reanalyse_job,
    start_job,
    subscribe_to_job,
)

__all__ = [
    "AnalyserJobOptions",
    "JobNotFoundError",
    "get_job_snapshot",
    "recent_jobs",
    "reanalyse_job",
    "start_job",
    "subscribe_to_job",
]
