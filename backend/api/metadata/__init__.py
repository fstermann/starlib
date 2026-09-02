"""Meta Editor API routes.

FastAPI endpoints for metadata editing operations:
- File listing and folder operations
- Track metadata read/update
- File finalization (conversion and moving)
- Artwork management
"""

from fastapi import APIRouter
from fastapi_pagination.utils import disable_installed_extensions_check

from backend.api.metadata.artwork import router as artwork_router
from backend.api.metadata.audio import router as audio_router
from backend.api.metadata.browse import router as browse_router
from backend.api.metadata.collection import router as collection_router
from backend.api.metadata.files import router as files_router
from backend.api.metadata.folders import router as folders_router
from backend.api.metadata.proxy import router as proxy_router

disable_installed_extensions_check()

router = APIRouter(prefix="/api/metadata", tags=["metadata"])

# Order matters: FastAPI matches routes in registration order, so the literal
# /folders/... paths must be registered before /folders/{mode}/...
router.include_router(folders_router)
router.include_router(browse_router)
router.include_router(files_router)
router.include_router(artwork_router)
router.include_router(audio_router)
router.include_router(collection_router)
router.include_router(proxy_router)
