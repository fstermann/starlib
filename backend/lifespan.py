"""Application startup and shutdown.

Initialises the cache DB, starts the filesystem watcher and kicks off an
index scan per configured folder; unwinds all three on shutdown.
"""

import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from backend.config import get_backend_settings
from backend.infra import cache, watcher
from backend.infra.ai import ollama as ollama_service
from backend.infra.analyser import db as analyser_db
from backend.infra.soundcloud import client as sc_client
from backend.services import app_settings as app_settings_service
from backend.services import folder_config as folder_config_service
from backend.services.collection.indexing import ensure_folder_indexed

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_backend_settings()
    root = Path(app_settings_service.get_root_music_folder()).expanduser()

    # Initialise SQLite cache (creates tables if first run)
    cache.init_db(settings.cache_dir / "metadata.db")

    stale = analyser_db.mark_running_jobs_as_error("backend restarted; please re-run analysis")
    if stale:
        logger.info("analyser: marked %d stale running job(s) as error", stale)

    # Pruning stat()s every cached path; on a large library that is tens of
    # thousands of syscalls. Off the startup path — nothing below depends on it.
    threading.Thread(target=cache.prune_missing_files, daemon=True).start()

    # Start watchdog observer for real-time file change detection
    watcher.start_watcher(root)

    # Kick off initial mtime-comparison scan for each configured folder
    folders_config = folder_config_service.load_folders()
    for fc in folders_config.folders:
        folder = Path(fc.path) if fc.path else root / fc.name
        if folder.is_dir():
            logger.info("Starting index scan for %s", folder)
            ensure_folder_indexed(folder)

    yield

    await sc_client.close_client()
    await ollama_service.close_client()
    ollama_service.shutdown()
    watcher.stop_watcher()
