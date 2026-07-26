"""Application startup and shutdown.

Initialises the cache DB, starts the filesystem watcher and kicks off an
index scan per configured folder; unwinds all three on shutdown.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from backend.config import get_backend_settings
from backend.infra import cache, watcher
from backend.infra.ai import ollama as ollama_service
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
    cache.prune_missing_files()

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

    ollama_service.shutdown()
    watcher.stop_watcher()
