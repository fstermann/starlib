# Getting Started

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Python | 3.13+ | [python.org](https://www.python.org/) |
| uv | latest | `pip install uv` |
| Node.js | ≥ 22 | `brew install node` |

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/fstermann/starlib.git
cd starlib
```

### Backend

```bash
uv sync
```

### Frontend

```bash
cd frontend
npm install
```

## Configuration

Create a `.env` file in the project root with your SoundCloud credentials:

```env
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
USER_ID=your_soundcloud_user_id
```

**How to get credentials:**

1. Register your app at the [SoundCloud Developer Portal](https://soundcloud.com/you/apps)
2. Copy `CLIENT_ID` and `CLIENT_SECRET` from your app settings
3. Add them to the `.env` file

## Running the application

Start both services:

```bash
# Terminal 1 – Backend
uv run python -m backend.main
```

```bash
# Terminal 2 – Frontend
cd frontend && npm run dev
```

The backend API is available at `http://localhost:8000` and the frontend at `http://localhost:3000`.

### API documentation

Once the backend is running, interactive API docs are available at:

- **Swagger UI:** [localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc:** [localhost:8000/redoc](http://localhost:8000/redoc)

## Make targets

Common dev tasks live in the repo-root `Makefile`. Run `make help` to list them.

### Run

| Target | Description |
|--------|-------------|
| `make dev` | Run backend and frontend together (Ctrl-C stops both) |
| `make backend` | Run the FastAPI backend on `:8000` |
| `make frontend` | Run the Next.js frontend on `:3000` |
| `make docs` | Serve the Zensical docs on `:8200` |

### Quality

| Target | Depends on | Description |
|--------|------------|-------------|
| `make check` | `lint` + `format-check` + `typecheck` + `test` | Full CI-equivalent gate |
| `make lint` | `lint-be` + `lint-fe` | Ruff + ESLint |
| `make lint-be` | — | `ruff check` |
| `make lint-fe` | — | `npm run lint` |
| `make format` | — | Write formatting: Ruff + Prettier |
| `make format-check` | — | Check formatting without writing |
| `make typecheck` | — | mypy + `tsc --noEmit` |
| `make test` | `test-be` + `test-fe` | Backend + frontend unit tests |
| `make test-be` | — | `pytest tests/` |
| `make test-fe` | — | `vitest run` |
| `make test-e2e` | — | Playwright e2e suite |

### Assets & build

| Target | Depends on | Description |
|--------|------------|-------------|
| `make generate` | — | Regenerate SoundCloud + backend OpenAPI TS clients |
| `make icons` | — | Generate desktop icons from `assets/starlib-dark-grad.png` (override with `ICON_SOURCE=...`) |
| `make screenshot` | — | Capture all documentation screenshots |
| `make build` | — | Build the full desktop app (sidecar + frontend + Tauri) |
| `make run` | `build` | Build then launch the desktop app |

### `make screenshot`

Fetches fresh track metadata from the iTunes Search API, then runs the Playwright screenshot suite (`screenshots.spec.ts`) and writes PNGs to `docs/assets/images/screenshots/`. The track cache is stored in `.cache/screenshot-tracks.json`.

```bash
make screenshot
```

Make sure the frontend dev server is running (`make frontend`) before capturing screenshots, or let Playwright start it automatically via `reuseExistingServer`.
