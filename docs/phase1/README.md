# Phase 1 — Logic Extraction

## Status: ✅ Meta Editor Complete

This directory contains documentation for Phase 1 of the migration: extracting pure business logic from Streamlit pages into the `backend/core/` layer.

## Completed Pages

1. ✅ **[Meta Editor](meta-editor-extraction.md)** — Track metadata operations
   - Extracted: `metadata.py`, `collection.py`, `soundcloud.py`
   - Functions: 25 pure functions with zero Streamlit dependencies
   - Lines: ~800 lines of business logic

## Pending Pages

2. ⏳ **Like Explorer** — Playlist creation from artist likes/reposts
3. ⏳ **Key Shifter** — BPM analysis and key calculation
4. ⏳ **BPM Shifter** — Track identification and pitch shifting
5. ⏳ **Artist Manager** — Configuration management

## Extraction Principles

Following [AGENTS.md](../../AGENTS.md) strictly:

### ✅ Do
- Extract pure functions with explicit inputs/outputs
- Remove ALL Streamlit dependencies
- Preserve existing function names and logic
- Document parameters and return values
- Keep functions testable

### ❌ Don't
- Refactor or rename concepts
- Create API endpoints (Phase 2)
- Build frontend components (Phase 3)
- Change existing interfaces
- Assume deployment model

## Directory Structure

```
backend/
├── core/
│   ├── services/          # 🎯 Phase 1 target
│   │   ├── metadata.py    # ✅ Complete
│   │   ├── collection.py  # ✅ Complete
│   │   ├── soundcloud.py  # ✅ Complete
│   │   ├── playlist.py    # ⏳ Next: Like Explorer
│   │   ├── analysis.py    # ⏳ Next: Key/BPM Shifter
│   │   └── identification.py  # ⏳ Next: BPM Shifter
│   └── domain/            # Pure functions (if needed)
```

## Next Steps

### Before Phase 2 (API Definition)

Answer these questions:

1. **Deployment Model**
   - Local-only or web-hosted?
   - Single-user or multi-tenant?

2. **Background Tasks**
   - FastAPI BackgroundTasks (simple) or Celery (robust)?
   - How to report progress?

3. **Real-Time Updates**
   - Polling or WebSockets/SSE?

4. **File Storage**
   - Local filesystem or cloud (S3)?

**Recommendation**: Start with local-only, single-user, BackgroundTasks, polling

### Remaining Work

- Extract Like Explorer logic → `playlist.py`
- Extract Key/BPM Shifter logic → `analysis.py`
- Extract BPM Shifter identification → `identification.py`
- Extract Artist Manager logic → `artists.py` (if needed)
- Write unit tests for extracted functions
- Create integration tests for workflows

## Verification

Phase 1 is complete for a page when:

- ✅ All business logic extracted to `backend/core/services/`
- ✅ Zero Streamlit imports in extracted code
- ✅ All functions have type hints and docstrings
- ✅ Functions are testable with explicit state
- ✅ Existing interfaces (TrackHandler, etc.) preserved
- ✅ Documentation created in `docs/phase1/`

## Progress

- **Meta Editor**: ✅ 100% complete
- **Like Explorer**: 0%
- **Key Shifter**: 0%
- **BPM Shifter**: 0%
- **Artist Manager**: 0%

**Overall Phase 1 Progress**: 20% (1 of 5 pages)

## Time Estimates

Based on Meta Editor extraction:

- Like Explorer: 2-3 hours (API-heavy)
- Key Shifter: 2-3 hours (dual functionality)
- BPM Shifter: 3-4 hours (complex workflows)
- Artist Manager: 1-2 hours (simple config)
- Testing: 3-4 hours

**Total Remaining**: 11-16 hours

---

Ready to proceed to next page or Phase 2?
