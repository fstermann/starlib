# SoundCloud Tools — Phase 0 Overview

## Application Structure

### Technology Stack

**Current (Streamlit)**:
- **Framework**: Streamlit (single-file page navigation)
- **UI Components**: Built-in Streamlit widgets + custom components
- **State Management**: `st.session_state` (global mutable dictionary)
- **API Client**: Async HTTP client (aiohttp-based)
- **Audio Processing**: Mutagen, Essentia, pydub, ffmpeg
- **Track Identification**: Shazamio (Shazam API wrapper)

**Target (FastAPI + Next.js)**:
- **Backend**: FastAPI (Python REST API)
- **Frontend**: Next.js 14+ (App Router)
- **UI Components**: shadcn/ui (React + Tailwind)
- **State Management**: React hooks (useState, useEffect) + Zustand/Context for global state
- **API Communication**: fetch/axios with proper TypeScript types

### Page Organization

```
soundcloud_tools/streamlit/
├── app.py                      # Main entry point, navigation setup
├── file_selection.py           # Shared file/folder selector component
├── components.py               # Reusable metadata editor components
├── utils.py                    # Shared utilities (table, embed, state reset)
├── collection.py               # Collection operations (genre charts, etc.)
├── client.py                   # SoundCloud API client wrapper
└── tools/
    ├── meta_editor.py          # Page: Edit track metadata, convert, finalize
    ├── like_explorer.py        # Page: Explore artist likes/reposts, create playlists
    ├── key_shifter.py          # Page: Calculate key shifts, batch BPM analysis
    ├── bpm_shifter.py          # Page: Download, analyze, shift, identify tracks
    └── artist_manager.py       # Page: Browse/filter followed artists, manage config
```

## Shared Components

### 1. File Selection Component

**File**: `file_selection.py`

**Responsibilities**:
- Folder mode selection (prepare/collection/cleaned/direct)
- Audio file scanning and listing
- Collection filtering (genre, artist, key, BPM, date range, harmonic mixing)
- File navigation (previous/next with state management)
- Move operations (batch file moving between folders)

**Used By**: Meta Editor, Key Shifter

**State Management**:
- `mode`: Current folder mode
- `index`: Currently selected file index
- `selection`: Currently selected file
- `new_track_name`: Filename after rename (for navigation update)
- `file_filters`: Boolean to show/hide filter UI

**Key Functions**:
- `file_selector()` → Returns (Path | None, Path) for selected file and root folder
- `render_folder_selection()` → UI for folder mode and validation
- `render_file_selection(files)` → UI for file navigation with prev/next
- `render_filters(path)` → UI for collection filtering with multi-select
- `render_file_moving(handler, target, filters)` → Dialog for batch file moves

### 2. Metadata Editor Components

**File**: `components.py`

**Responsibilities**:
- Reusable UI components for editing track metadata fields
- Action buttons (clean, titelize, copy from SoundCloud)
- Artist option popovers for quick selection
- Artwork display and management
- Embedded SoundCloud player rendering

**Components**:
- `title_editor()` → Title field with 6 action buttons
- `artist_editor()` → Artist field with cleaning, options popover
- `genre_editor()` → Genre field with quick-select buttons, BPM/key display
- `dates_editor()` → Release date picker
- `artwork_editor()` → Artwork URL input with preview
- `remix_editor()` → Full remix info (remixer, original artist, mix name)
- `comment_editor()` → Comment field with SoundCloud embed
- `render_artist_options()` → Popover with clickable artist suggestions

**Used By**: Meta Editor exclusively

**Helper Functions**:
- `build_component_columns(n_buttons, left, mid)` → Layout helper for consistent column structure
- `changed_string(old, new)` → Visual indicator when value changed
- `apply_to_sst(func, key)` → Curried function for session state transformations

### 3. Utility Functions

**File**: `utils.py`

**Shared Utilities**:
- `table(data)` → Render data as HTML table with custom styling
- `render_embedded_track(track, height)` → SoundCloud iframe player
- `reset_track_info_sst()` → Clear all `ti_*` session state keys
- `wrap_and_reset_state(func)` → Decorator to reset state after action
- `display_collection_tracks(collection, caption)` → Display track list with players
- `apply_to_sst(func, key)` → Apply transformation function to session state value
- `generate_css(**kwargs)` → Convert Python dict to CSS string

**Used By**: All pages

### 4. SoundCloud API Client

**File**: `client.py`

**Client Wrapper**:
- Singleton pattern via `get_client()`
- Async methods for all SoundCloud API endpoints
- Token-based authentication via settings

**Key Methods**:
- `search(q: str)` → Search for tracks/users/playlists
- `get_track(track_id: int)` → Fetch track details
- `get_track_id(url: str)` → Extract track ID from URL
- `get_user_likes(user_id, limit, offset)` → Paginated likes
- `get_user_reposts(user_id, limit, offset)` → Paginated reposts
- `get_artist_shortcuts()` → Fetch followed artists
- `post_playlist(data)` → Create playlist
- `update_playlist_image(playlist_urn, data)` → Update playlist artwork

**Used By**: Like Explorer, Artist Manager, BPM Shifter, Meta Editor (search)

### 5. Data Models

**Files**: `soundcloud_tools/models/*.py`

**Pydantic Models**:
- `Track`: SoundCloud track with full metadata
- `User`: SoundCloud user/artist profile
- `Playlist`: Playlist metadata
- `Repost`: Like or repost wrapper with timestamp
- `Comment`: Structured comment with SoundCloud link
- `TrackInfo`: Internal track metadata model
- `Remix`: Remix-specific metadata

**Used Everywhere**: Type safety for API responses and internal data structures

### 6. Audio Handlers

**File**: `soundcloud_tools/handler/track.py`

**TrackHandler Class**:
- Abstraction for audio file operations
- Metadata reading/writing (ID3, AIFF chunks)
- Format conversion (MP3 ↔ AIFF)
- File renaming based on metadata
- Artwork embedding/extraction
- Move operations (prepare → cleaned → archive)

**Key Methods**:
- `track_info` property → Extracts TrackInfo from file
- `add_info(track_info, artwork)` → Writes metadata to file
- `rename(filename)` → Renames file, returns new path
- `convert_to_mp3()` / `convert_to_aiff()` → Format conversion via ffmpeg
- `add_mp3_info()` / `add_aiff_info()` → Metadata copy after conversion
- `move_to_cleaned()` → Move to final destination
- `archive()` → Move original to archive
- `delete()` → Delete file

**Used By**: Meta Editor, Key Shifter (for batch operations)

### 7. Audio Predictors

**Files**: `soundcloud_tools/predict/*.py`

**Predictor Classes**:
- `BPMPredictor`: Essentia-based BPM detection
- `StylePredictor`: Genre classification (unused in current pages)
- `MoodPredictor`: Mood classification (unused)

**Used By**: Key Shifter (BPM), Collection operations (unused in main pages)

## State Management Patterns

### Session State Structure

Streamlit uses a global mutable dictionary (`st.session_state`) for state management.

**Conventions**:
- `ti_*`: Track info fields (title, artist, genre, etc.)
- `{page}_*`: Page-specific state (e.g., `analysis_results` in Key Shifter)
- Shared keys: `index`, `selection`, `mode`, `search_result`, `sc_search_cache`

**Lifecycle**:
- Persists across reruns within a session
- Cleared on page refresh or session timeout
- Must be manually reset when navigating between files

**Common Patterns**:
```python
# Initialize default
sst.setdefault("key", default_value)

# Update and rerun
sst["key"] = new_value
st.rerun()

# Bulk reset
reset_track_info_sst()  # Clears all ti_* keys

# Conditional update
if st.button("Action"):
    sst["key"] = value
    st.rerun()
```

### Caching Strategy

**Streamlit Caching**:
- `@st.cache_data`: Cache function results by input arguments
- Used for: API searches, file loading, user searches
- Invalidation: Manual or via arguments change

**File-based Caching**:
- BPM Shifter: Persistent cache directory (.cache/tracks/)
- Cached items: Downloaded tracks, Shazam results (JSON), audio snippets
- Management: Manual clear via UI button

## Filesystem Architecture

### Folder Structure

```
{root_music_folder}/
├── prepare/              # Staging area for new tracks
│   └── *.{mp3,aiff,wav}  # Unprocessed files
├── collection/           # Main organized library
│   └── *.{mp3,aiff}      # Finalized tracks with complete metadata
├── cleaned/              # Final export destination
│   └── *.mp3             # 320kbps MP3 files ready for DJ use
└── archive/              # Original files after conversion
    └── *.{aiff,wav}      # Source files preserved
```

**Flow**: `Downloads` → `prepare` → (edit) → `cleaned` OR `collection`

### File Operations

**Read-Only**:
- Audio playback
- Metadata extraction
- BPM/key analysis
- Genre prediction

**Destructive**:
- Metadata updates (in-place)
- Format conversion (creates new file)
- File renaming
- File moving (between folders)
- File deletion
- Artwork embedding/removal

**Transactional Safety**: None — all operations are immediate and permanent

## API Integration Patterns

### SoundCloud API

**Authentication**:
- OAuth2 token stored in settings
- Token refresh: Not implemented (manual renewal)

**Rate Limiting**:
- No explicit handling in client
- BPM Shifter: Batch delays for Shazam API

**Error Handling**:
- Exceptions propagate to UI
- Streamlit displays error messages automatically

**Data Flow**:
1. User action triggers API call
2. Async function executes via `asyncio.run()`
3. Response parsed into Pydantic models
4. Data stored in session state or displayed directly

### Shazam API (via shazamio)

**Track Identification**:
- Audio snippets uploaded as files
- Response includes track title, artist, genre, artwork, links
- Rate limiting via batch processing + delays

**Caching**:
- Results saved to JSON after each batch
- Incremental updates for resilience
- Snippets kept for playback comparison

## Critical Migration Considerations

### 1. State Management

**Challenge**: Streamlit's global session state vs. React's component-level state

**Solution**:
- Convert `ti_*` fields to React form state (controlled inputs)
- Use Zustand or Context for page-level state (e.g., analysis results)
- URL state for navigation (file selection, current page)
- Local storage for user preferences (folder paths, settings)

### 2. File System Access

**Challenge**: Streamlit has direct filesystem access; browsers cannot

**Solution**:
- **Backend handles ALL filesystem operations**
- API endpoints for:
  - List files in folder
  - Read metadata from file
  - Write metadata to file
  - Move/rename/delete files
  - Convert between formats
- **Frontend uses file pickers for input, downloads for output**

### 3. Audio Processing

**Challenge**: Heavy processing (BPM, format conversion) blocks UI in Streamlit

**Solution**:
- **Move ALL audio processing to backend**
- Use background tasks (Celery/Redis or FastAPI BackgroundTasks)
- WebSocket or polling for progress updates
- Return task IDs immediately, client polls for completion

### 4. Caching

**Challenge**: Streamlit's decorator-based caching vs. explicit cache management

**Solution**:
- **Backend caching**:
  - Redis for API responses (search results, user data)
  - Filesystem cache for audio files (same structure)
- **Frontend caching**:
  - React Query for API response caching
  - Browser cache for static assets

### 5. Async Operations

**Challenge**: Streamlit runs async via `asyncio.run()` blocking the script

**Solution**:
- FastAPI natively supports async/await
- Use `async def` for all I/O operations
- Concurrent requests handled by ASGI server (uvicorn)
- Long-running tasks offloaded to background workers

### 6. Component Reusability

**Challenge**: Streamlit components are function calls with side effects

**Solution**:
- shadcn/ui provides composable React components
- Create custom hooks for shared logic (e.g., `useTrackInfo()`)
- Separate presentational from container components
- Shared API client as React Context or hook

## Page-Specific Migration Notes

### Meta Editor
- **Most Complex**: Many interdependent fields, auto-actions
- **Key Challenge**: SoundCloud search integration within form
- **Critical Path**: Finalize workflow (convert + move)

### Like Explorer
- **API-Heavy**: Multiple paginated endpoints
- **Key Challenge**: Efficient filtering of large datasets
- **Critical Path**: Playlist creation with image upload

### Key Shifter
- **Dual Functionality**: Simple calculator + batch analysis
- **Key Challenge**: Long-running BPM analysis with progress
- **Critical Path**: Metadata writing to many files

### BPM Shifter
- **Most Complex**: Multi-step workflow with caching
- **Key Challenge**: Track identification with retry logic
- **Critical Path**: Download → Analyze → Identify → Select variations

### Artist Manager
- **Pure Configuration**: No audio processing
- **Key Challenge**: Large dataset filtering + pagination
- **Critical Path**: Configuration export and manual deployment

## Security & Privacy Considerations

### SoundCloud API Tokens
- **Current**: Stored in `.env` file (not in repo)
- **Backend**: Environment variables only
- **Frontend**: NEVER expose tokens

### File Access
- **Current**: Full filesystem access
- **Backend**: Restrict to configured music directory only
- **Frontend**: No direct access, all via API

### User Data
- **Likes/Reposts**: Fetched via authenticated API
- **Personal Info**: Username, followed artists
- **Privacy**: All operations on user's own data only

## Next Steps (Phase 1 — Logic Extraction)

Per [AGENTS.md](../AGENTS.md), Phase 1 focuses on extracting pure Python logic:

1. **Create `backend/core/` directory structure**
2. **Extract stateless functions** (no Streamlit dependencies):
   - String utilities (`soundcloud_tools/utils/string.py`) ✅ Already separated
   - Audio predictors (`soundcloud_tools/predict/`) ✅ Already separated
   - Data models (`soundcloud_tools/models/`) ✅ Already separated
3. **Extract handlers with explicit state**:
   - `TrackHandler` → already stateless ✅
   - File operations → add explicit input/output paths
4. **Extract API client**:
   - `soundcloud_tools/client.py` → Already exists ✅
   - Ensure no Streamlit imports
5. **Create domain service layer**:
   - `MetadataService`: Track info operations
   - `CollectionService`: File listing, filtering
   - `PlaylistService`: Like fetching, playlist creation
   - `AnalysisService`: BPM, key, transition detection
   - `IdentificationService`: Shazam integration

**Definition of Done for Phase 1**:
- All domain logic in `backend/core/`
- Zero Streamlit imports in core modules
- Testable functions with explicit inputs/outputs
- Documentation updated with API surfaces

## Migration Risks

### High Risk
- **File operations**: Errors could corrupt user's music library
- **Format conversion**: Lossy conversion from AIFF to MP3
- **Metadata loss**: Incorrect tag writing could lose data

**Mitigation**: Extensive testing, backup recommendations, dry-run mode

### Medium Risk
- **API rate limits**: SoundCloud/Shazam may throttle
- **Cache corruption**: JSON cache files could become invalid
- **Session loss**: Incomplete operations if server restarts

**Mitigation**: Retry logic, cache validation, idempotent operations

### Low Risk
- **UI complexity**: shadcn/ui may not match Streamlit's ease
- **Type safety**: TypeScript strictness may slow development
- **State synchronization**: React state may drift from backend

**Mitigation**: Follow established patterns, thorough testing, state validation

## Success Criteria

A page is successfully migrated when:
1. **Functional parity**: All features work identically
2. **No data loss**: Metadata preserved through all operations
3. **Error handling**: Graceful degradation, clear error messages
4. **Performance**: Equal or better response times
5. **UX consistency**: Similar layout, intuitive interactions
6. **Documentation**: Updated README and migration notes

## Open Questions

1. **Authentication**: How to handle SoundCloud OAuth in web app?
   - Option A: Backend-only token (admin sets in env)
   - Option B: OAuth flow for each user (per-user tokens)

2. **Multi-user support**: Single-user app or multi-tenant?
   - Current: Single-user (personal tool)
   - Target: TBD based on deployment model

3. **Deployment**: Where will this run?
   - Option A: Local (localhost, no auth needed)
   - Option B: Self-hosted (Docker, basic auth)
   - Option C: Cloud (Vercel/Railway, full auth)

4. **File storage**: Where do audio files live?
   - Current: Local filesystem
   - Target: Same (backend mounts local volume) OR cloud storage (S3)

5. **Real-time updates**: How to show progress for long operations?
   - Option A: Polling (frontend checks status endpoint)
   - Option B: WebSockets (push updates)
   - Option C: Server-Sent Events (one-way push)

These questions should be answered **before** starting Phase 2 (API Definition).
