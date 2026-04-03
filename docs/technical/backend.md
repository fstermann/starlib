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
├── api/              # FastAPI route handlers
│   ├── auth.py       # OAuth 2.1 endpoints
│   ├── deps.py       # Dependency injection
│   ├── setup.py      # Setup/config endpoints
│   └── metadata/     # Metadata editing endpoints
│       ├── artwork.py
│       ├── audio.py
│       ├── collection.py
│       ├── files.py
│       └── proxy.py
├── core/             # Business logic
│   └── services/
│       ├── cache_db.py     # Caching layer
│       ├── collection.py   # Collection management
│       ├── metadata.py     # Metadata operations
│       ├── soundcloud.py   # SoundCloud API wrapper
│       └── watcher.py      # File watcher
├── schemas/          # Pydantic models
│   ├── auth.py
│   ├── metadata.py
│   └── setup.py
├── config.py         # Backend configuration
└── main.py           # Application entry point
```

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
