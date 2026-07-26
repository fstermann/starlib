# Backend

The backend is a **FastAPI** application that handles SoundCloud authentication, metadata management, and audio file operations.

## Setup

### Environment variables

Configure the backend via a `.env` file in the project root:

```env
# SoundCloud Authentication (OAuth 2.1)
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
USER_ID=your_soundcloud_user_id
```

Additional settings can be customized with the `BACKEND_` prefix:

```env
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8000
BACKEND_RELOAD=True
```

!!! note "Where settings come from"
    In development the backend reads `.env` at the repo root, then `config.env` in the platform user-config directory (`com.starlib.Starlib`). In the packaged desktop app there is no `.env` — the Tauri shell passes the environment to the sidecar, and user config lives in that same directory.

### Running

```bash
uv run python -m backend.main
```

The API is available at `http://localhost:8000`.

## API documentation

Interactive API documentation is auto-generated:

- **Swagger UI:** [localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc:** [localhost:8000/redoc](http://localhost:8000/redoc)

## Project structure

```
backend/
├── api/                  # FastAPI route handlers
│   ├── ai.py             # AI provider config (Ollama / Claude Code / Anthropic)
│   ├── app_settings.py   # Application-level user settings
│   ├── auth.py           # OAuth 2.1 endpoints
│   ├── bpm.py            # BPM persistence (analysis runs in the Tauri layer)
│   ├── deps.py           # Dependency injection
│   ├── folder_config.py  # Folder display + per-folder ruleset config
│   ├── profile_groups.py # Profile groups
│   ├── rekordbox.py      # Rekordbox browse source (local DB or USB export)
│   ├── rulesets.py       # Finalization rulesets
│   ├── setup.py          # First-launch setup/config
│   ├── soundcloud.py     # Signed HLS stream URLs
│   ├── suggestions.py    # Ranked metadata suggestions
│   ├── system_playlists.py  # SoundCloud generated mixes
│   └── metadata/         # Metadata editing endpoints
│       ├── artwork.py
│       ├── audio.py
│       ├── collection.py
│       ├── files.py
│       └── proxy.py
├── core/                 # Business logic
│   ├── audio/            # Tag, folder, and title handling
│   ├── db/               # SQLite engine, models, migration runner
│   ├── domain/           # Domain types
│   └── services/         # Domain services (see below)
├── schemas/              # Pydantic request/response models
├── alembic/              # Database migrations
├── soundcloud_tools/     # Vendored SoundCloud client + models
├── config.py             # Backend configuration
└── main.py               # Application entry point
```

Notable services under `core/services/`:

| Service | Responsibility |
|---------|----------------|
| `cache_db.py` | Track/peaks cache on top of the SQLite layer |
| `collection.py` | Local collection indexing |
| `metadata.py` | Read/write audio tags |
| `rekordbox/` | Rekordbox database + USB export access |
| `rule_engine.py`, `ruleset.py` | Ruleset definition and execution |
| `suggesters/`, `suggestion_engine.py` | Ranked metadata suggestions |
| `analyser/` | Audio analysis |
| `ollama.py`, `anthropic.py`, `claude_code.py` | AI provider clients |
| `sc_oauth.py`, `sc_auth_cache.py` | SoundCloud OAuth + token cache |
| `credentials.py` | OS keychain access for secrets |
| `watcher.py` | Filesystem watcher |

## Key features

### OAuth 2.1 authentication

- Token exchange and refresh handled server-side (keeps `client_secret` secure)
- Automatic token refresh before expiry
- Token caching via `.oauth_cache.json`

### SoundCloud integration

- Track search and collection browsing
- Metadata retrieval and updates
- Artwork management
- Audio file proxying

### AI providers

- One set of `/api/ai/*` endpoints backed by three interchangeable providers: local [Ollama](https://ollama.com), the Claude Code CLI, and the Anthropic API
- Per-provider settings live under a single `AiSettings` block persisted in `settings.json`; the Anthropic API key goes to the OS credential store via `core/services/credentials.py`
- Health check, model listing, and completion per provider
- See the [AI providers user guide](../guide/ai.md) for setup instructions

### Persistence

State that isn't a user-editable config file lives in a SQLite cache database:

- **Engine** (`core/db/engine.py`) — one module-level SQLAlchemy engine, WAL mode with `synchronous=NORMAL`, pragmas reapplied on every pooled connection
- **Models** (`core/db/models.py`) — SQLModel tables: `tracks`, `peaks`, `soundcloud_track_bpm`
- **Migrations** (`core/db/migrations.py` + `backend/alembic/`) — Alembic runs `upgrade head` at startup. A DB with tables but no `alembic_version` (pre-#286) is caught up by the legacy bootstrap, backed up, stamped at `0001`, then upgraded.

Adding a schema change means editing the models and generating a revision under `backend/alembic/versions/` — never hand-editing the DB.

## Development

### Adding new endpoints

1. **Define schemas** in `schemas/` (request/response models)
2. **Implement service** in `core/services/` (business logic)
3. **Create route** in `api/` (HTTP layer)
4. **Register router** in `main.py`

### Testing

```bash
uv run python -m pytest tests/ -v
```
