# Starlib ⭐

Starlib is a DJ library management app. Organise your tracks, edit metadata, and manage artwork, all from a single interface.

## Architecture

| Component | Stack | Directory |
|-----------|-------|-----------|
| Backend API | FastAPI · Python | `backend/` |
| Frontend | Next.js · React · TypeScript | `frontend/` |
| Desktop app | Tauri v2 · Rust | `desktop/` |

## Quick start

```bash
# Terminal 1 – Backend
uv run python -m backend.main   # → http://localhost:8000

# Terminal 2 – Frontend
cd frontend && npm run dev       # → http://localhost:3000
```

## Documentation

Full documentation is available at [fstermann.github.io/soundcloud-tools](https://fstermann.github.io/soundcloud-tools/).
