# Starlib

Starlib is a DJ library management app. Organise your tracks, edit metadata, and manage artwork, all from a single interface.

## Features

- **OAuth 2.1 + PKCE** authentication with SoundCloud
- Browse and filter your SoundCloud collection
- Edit track metadata (title, genre, tags, artwork, …)
- Audio file management and proxying
- Native desktop application via Tauri

## Quick start

Start the backend and frontend in two terminals:

```bash
# Terminal 1 – Backend
uv run python -m backend.main
# → http://localhost:8000
```

```bash
# Terminal 2 – Frontend
cd frontend && npm run dev
# → http://localhost:3000
```

Then open [localhost:3000](http://localhost:3000) in your browser and connect your SoundCloud account.

## Project layout

```
starlib/
├── backend/          # FastAPI server (Python)
├── frontend/         # Next.js / React UI (TypeScript)
├── desktop/          # Tauri v2 native wrapper (Rust)
├── soundcloud_tools/ # SoundCloud API client & CLI tools
├── tests/            # Backend test suite
└── docs/             # This documentation
```
