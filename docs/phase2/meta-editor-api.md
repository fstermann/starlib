# Phase 2: API Definition — Meta Editor

**Status:** Complete ✅
**Date:** 2024
**Page:** Meta Editor

---

## Overview

Phase 2 defines the FastAPI backend API for the Meta Editor page. All endpoints expose the service layer functions extracted in Phase 1 through REST APIs with Pydantic validation.

---

## Files Created

### 1. Pydantic Schemas (`backend/schemas/metadata.py`)
**Purpose:** Type-safe request/response models for all endpoints
**Lines:** ~220

**Request Models:**
- `TrackInfoUpdateRequest` — Update track metadata fields
- `TrackInfoRequest` — Apply SoundCloud metadata to file
- `FinalizeRequest` — Finalize track (convert + move)
- `SoundCloudSearchRequest` — Search SoundCloud
- `CollectionFilterRequest` — Filter collection tracks
- `MoveFilesRequest` — Move files between folders

**Response Models:**
- `TrackInfoResponse` — Complete track metadata with readiness
- `FileInfoResponse` — Basic file information
- `FolderListResponse` — List of files with stats
- `FileReadinessResponse` — Readiness check result
- `FinalizeResponse` — Finalization result with new path
- `OperationResponse` — Generic success/failure
- `SoundCloudTrackResponse` — SoundCloud track info
- `SoundCloudSearchResponse` — Search results
- `CollectionStatsResponse` — Collection statistics
- `ArtworkResponse` — Artwork information

---

### 2. FastAPI Routes (`backend/api/metadata.py`)
**Purpose:** HTTP endpoints for metadata operations
**Lines:** ~670
**Route prefix:** `/api/metadata`

#### File & Folder Endpoints

**GET `/folders/{mode}/files`**
- List audio files in folder (prepare/collection/cleaned)
- Returns: `FolderListResponse`
- Validates folder existence

**GET `/files/{file_path:path}/info`**
- Get complete track metadata
- Returns: `TrackInfoResponse` with readiness check
- Security: Path validation

**POST `/files/{file_path:path}/info`**
- Update track metadata
- Body: `TrackInfoUpdateRequest`
- Returns: `OperationResponse`

**GET `/files/{file_path:path}/readiness`**
- Check if file ready for finalization
- Returns: `FileReadinessResponse`

**POST `/files/{file_path:path}/finalize`**
- Convert format and move to collection
- Body: `FinalizeRequest`
- Returns: `FinalizeResponse` with new path

**DELETE `/files/{file_path:path}`**
- Delete audio file
- Returns: `OperationResponse`

#### SoundCloud Endpoints

**POST `/soundcloud/search`**
- Search tracks on SoundCloud
- Body: `SoundCloudSearchRequest`
- Returns: `SoundCloudSearchResponse`
- Async operation

**GET `/soundcloud/track?url=...`**
- Get track by URL
- Query param: `url` (SoundCloud permalink)
- Returns: `SoundCloudTrackResponse`
- Async operation

**POST `/soundcloud/apply`**
- Apply SoundCloud metadata to file
- Body: `TrackInfoRequest`
- Returns: `OperationResponse`
- Async operation

#### Artwork Endpoints

**GET `/files/{file_path:path}/artwork`**
- Get artwork image
- Returns: `FileResponse` (JPEG/PNG)

**POST `/files/{file_path:path}/artwork`**
- Update artwork
- Query param: `artwork_path`
- Returns: `OperationResponse`

**DELETE `/files/{file_path:path}/artwork`**
- Remove artwork
- Returns: `OperationResponse`

#### Collection Endpoints

**GET `/collection/stats`**
- Get collection statistics
- Returns: `CollectionStatsResponse`

---

### 3. Dependencies (`backend/api/deps.py`)
**Purpose:** Dependency injection for routes
**Lines:** ~110

**Functions:**
- `get_soundcloud_client()` — Configured SoundCloud API client
- `get_root_folder()` — Root music folder from settings
- `validate_file_path()` — Security check for file paths
- `validate_folder_mode()` — Validate folder mode

**Security:**
- Path traversal prevention
- File existence checks
- Folder mode validation

---

### 4. Configuration (`backend/config.py`)
**Purpose:** Backend settings and environment config
**Lines:** ~50

**Settings:**
- API title, version, description
- Host/port configuration
- CORS origins (localhost:3000)
- Root music folder path
- Cache directory

Uses `pydantic-settings` for environment variable management.

---

### 5. Main Application (`backend/main.py`)
**Purpose:** FastAPI app creation and configuration
**Lines:** ~70

**Features:**
- CORS middleware for React frontend
- Router registration
- Health check endpoint
- Uvicorn startup script

**Endpoints:**
- `GET /health` — Health check

---

## API Design Decisions

### 1. **One Endpoint Per User Action**
Each user interaction in the Streamlit app gets a dedicated endpoint:
- View file list → `GET /folders/{mode}/files`
- View metadata → `GET /files/{path}/info`
- Edit metadata → `POST /files/{path}/info`
- Search SoundCloud → `POST /soundcloud/search`
- Finalize track → `POST /files/{path}/finalize`

### 2. **Path Parameters for File Operations**
Files identified by path in URL:
```
GET /api/metadata/files/prepare/track-001.wav/info
POST /api/metadata/files/prepare/track-001.wav/finalize
```

### 3. **Query Parameters for Simple Filters**
- SoundCloud URL: `GET /soundcloud/track?url=...`
- Artwork path: `POST /files/{path}/artwork?artwork_path=...`

### 4. **Request Bodies for Complex Data**
- Metadata updates: `TrackInfoUpdateRequest`
- SoundCloud search: `SoundCloudSearchRequest`
- Finalization options: `FinalizeRequest`

### 5. **Consistent Response Format**
- Success operations: `OperationResponse`
- Data responses: Specific typed models
- Errors: FastAPI `HTTPException` with status codes

### 6. **Security First**
- Path validation prevents directory traversal
- File existence checks before operations
- Folder mode validation

### 7. **Async for I/O Operations**
SoundCloud API calls use `async/await`:
- Search tracks
- Fetch by URL
- Apply metadata

---

## Mapping: Streamlit → FastAPI

| Streamlit Component | FastAPI Endpoint | Method |
|---------------------|------------------|--------|
| Folder selector | `GET /folders/{mode}/files` | GET |
| File selector | `GET /files/{path}/info` | GET |
| Metadata form | `POST /files/{path}/info` | POST |
| SoundCloud search | `POST /soundcloud/search` | POST |
| Fetch from URL | `GET /soundcloud/track` | GET |
| Apply SC metadata | `POST /soundcloud/apply` | POST |
| Finalize button | `POST /files/{path}/finalize` | POST |
| Delete button | `DELETE /files/{path}` | DELETE |
| Artwork viewer | `GET /files/{path}/artwork` | GET |
| Upload artwork | `POST /files/{path}/artwork` | POST |
| Remove artwork | `DELETE /files/{path}/artwork` | DELETE |
| Collection stats | `GET /collection/stats` | GET |

---

## Dependencies Required

Add to `pyproject.toml`:
```toml
[project.dependencies]
fastapi = "^0.115.0"
uvicorn = "^0.32.0"
pydantic = "^2.10.0"
pydantic-settings = "^2.7.0"
```

---

## Running the Backend

```bash
# Development
python -m backend.main

# Or with uvicorn directly
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Access:
- API: http://localhost:8000
- Docs: http://localhost:8000/docs
- Health: http://localhost:8000/health

---

## Testing the API

### Example: List Files
```bash
curl http://localhost:8000/api/metadata/folders/prepare/files
```

### Example: Get Track Info
```bash
curl http://localhost:8000/api/metadata/files/prepare%2Ftrack.wav/info
```

### Example: Update Metadata
```bash
curl -X POST http://localhost:8000/api/metadata/files/prepare%2Ftrack.wav/info \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Track",
    "artist": "Artist Name",
    "bpm": 128,
    "key": "Am"
  }'
```

### Example: Search SoundCloud
```bash
curl -X POST http://localhost:8000/api/metadata/soundcloud/search \
  -H "Content-Type: application/json" \
  -d '{"query": "artist - track name", "limit": 10}'
```

---

## Next Steps

**Phase 3** will create the React frontend:
1. Next.js 14 App Router setup
2. shadcn/ui component integration
3. Meta Editor page implementation
4. API client with type safety
5. State management for form/search

---

## Success Criteria ✅

- [x] All Streamlit operations have corresponding endpoints
- [x] Pydantic models provide type safety
- [x] Security validation for file paths
- [x] Async support for SoundCloud operations
- [x] CORS configured for frontend
- [x] Health check endpoint
- [x] Auto-generated API documentation
- [x] No Streamlit dependencies in backend code

---

## Notes

- Backend is now fully independent from Streamlit
- All service functions from Phase 1 are exposed
- Frontend can be built without touching backend
- API documentation auto-generated at `/docs`
- Error handling uses standard HTTP status codes
