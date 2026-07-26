# Backend restructure plan

Working document. Analysis of the current `backend/` package, a proposed target
layout, and a phased migration. Delete once the migration is done and
`docs/technical/backend.md` reflects the new tree.

---

## 1. Current state

89 Python modules, ~12.7k lines.

```
backend/
├── main.py            app factory + lifespan + health route + uvicorn entry
├── config.py          BackendSettings (env, BACKEND_ prefix)
├── sc_settings.py     SoundCloud Settings (env, credentials)
├── alembic/           migrations (env.py + versions/)
├── api/               13 routers, flat, + metadata/ subpackage + deps.py
├── schemas/           11 flat pydantic modules
└── core/
    ├── __init__.py
    ├── domain/        EMPTY (one docstring)
    ├── audio/         tags.py (690), titles.py (164), folders.py (80)
    ├── db/            engine.py, models.py, migrations.py
    └── services/      20 flat modules + suggesters/ + rekordbox/
```

Layering is directionally correct — `api → core → schemas`, no reverse edges,
no `core → api` imports. The problems are cohesion and naming, not direction.

### 1.1 `core/domain/` is empty

The intended domain layer was never populated. Actual domain logic — pure,
I/O-free, dependency-free — already exists but lives elsewhere:

| Module | Lines | Backend imports |
|---|---|---|
| `core/audio/titles.py` | 164 | none |
| `core/audio/folders.py` | 80 | none |
| `core/services/list_format.py` | 71 | none |
| `core/services/filename_parser.py` | 78 | titles, suggestion_engine |
| `core/services/rule_engine.py` | 164 | tags, schemas.ruleset |
| `core/services/suggesters/*` | ~640 | schemas.suggestions, engine |
| `core/audio/tags.py` | 690 | titles, folders |

That is roughly 1.9k lines of pure logic sitting in a package named `services`
next to modules that open sockets and write SQLite.

### 1.2 `core/services/` is a grab bag

20 flat modules with four unrelated responsibilities mixed together:

- **Infrastructure adapters** (talk to the outside world):
  `cache_db.py` (668), `watcher.py`, `ollama.py`, `anthropic.py`,
  `claude_code.py`, `sc_oauth.py`, `sc_auth_cache.py`, `credentials.py`,
  `rekordbox/*`
- **Application use cases** (orchestrate domain + infra):
  `collection.py` (593), `metadata.py` (535), `ruleset.py`, `profile_group.py`,
  `folder_config.py`
- **Pure domain**: `rule_engine.py`, `suggestion_engine.py`, `suggesters/*`,
  `filename_parser.py`, `list_format.py`
- **Config persistence**: `settings.py`, `app_settings.py`

Nothing in the name or location tells you which one you are looking at.
`core/` adds a directory level with no discriminating power: everything that
isn't `api` is under `core`.

### 1.3 Four settings concepts, two of them loose at the top level

| Where | What | Kind |
|---|---|---|
| `backend/config.py` | `BackendSettings` — host, port, CORS, cache dir | process env |
| `backend/sc_settings.py` | `Settings` — SC client id/secret, base URL, proxy | adapter env |
| `core/services/settings.py` | `settings.json` load/save/update + migrations | user data store |
| `core/services/app_settings.py` | 30-line facade over one slice of the above | facade |

Two `Settings` classes and a `BackendSettings`, none of which are related.
`sc_settings.py` is imported by five routers directly — SoundCloud credential
config is reaching straight into the transport layer.

### 1.4 SoundCloud HTTP infrastructure lives inside routers

`api/soundcloud.py` (417) and `api/system_playlists.py` (205) contain raw
`httpx.AsyncClient` construction, per-call timeouts, TTL response caches,
in-flight request locks, redirect-host allowlisting, `Authorization` header
parsing and SC error-code mapping. There is no SoundCloud client module at all.

Consequences: timeout/error-mapping logic is duplicated across two routers, the
transcoding/stream-URL resolution flow can only be tested through the HTTP
route, and the top-level `soundcloud_tools/` package that used to hold this is
now dead (see 1.7).

### 1.5 `schemas/` conflates two different contracts

Flat package mixing:

- **Wire DTOs** (change freely, versioned by the API): `metadata.py`, `tree.py`,
  `suggestions.py`, `auth.py`, `setup.py`
- **Persisted file format** (`settings.json` on the user's disk, needs
  migration shims — see `Settings._upgrade_legacy_bindings`):
  `settings.py`, `ruleset.py`, `folder_config.py`, `profile_group.py`,
  `ai.py`, `ollama.py`

These have opposite change costs. Renaming a wire field is a frontend edit;
renaming a persisted field breaks every existing install. The current package
name says neither.

Meanwhile three routers (`bpm.py`, `soundcloud.py`, `system_playlists.py`)
define their request/response models inline instead of in `schemas/` — so the
convention is not even applied consistently.

### 1.6 Cycles patched with function-local imports

Five deferred imports exist purely to dodge import cycles:

| Site | Target | Real cycle? |
|---|---|---|
| `audio/tags.py:263` | `audio.titles` | **No** — `titles` imports nothing from backend. Hoistable today. |
| `services/watcher.py:162` | `backend.config` | **No.** Hoistable. |
| `services/rule_engine.py:105` | `services.app_settings` | **No**, but it is a layering smell: pure rule evaluation reads global user settings. |
| `services/suggestion_engine.py:155` | `suggesters.REGISTRY` | **Yes.** Engine defines the `FieldSuggester` protocol; `suggesters/__init__` imports the protocol and exports the registry. |
| `services/suggestion_engine.py:214` | `services.filename_parser` | **Yes.** `filename_parser` imports the engine. |

### 1.7 Dead package: `soundcloud_tools/`

`soundcloud_tools/` contains only `__pycache__` directories — every `.py` file
is gone. No source, config or doc references it (`AGENTS.md` was just updated to
drop it). Pure deletion.

### 1.8 Oversized modules

| Module | Lines | Distinct responsibilities |
|---|---|---|
| `api/metadata/files.py` | 1018 | folder init/fetch-from-downloads, folder tree + browse/filter queries, per-file CRUD |
| `core/audio/tags.py` | 690 | tag registry, read, write, artwork, starlib_meta frame |
| `core/services/cache_db.py` | 668 | tracks, peaks, SC bpm, filter/query builder, stats — three aggregates in one module |
| `core/services/collection.py` | 593 | indexing pipeline + folder ops + filtering facade |

### 1.9 Tests do not mirror the source

`tests/` is flat (28 modules) with a single `tests/api/` subdirectory. Finding
the test for a module means guessing the filename.

---

## 2. Target layout

Layered, hexagonal-lite. Four rings, dependencies point strictly inward:

```
api  →  services  →  domain
             ↓          ↑
           infra  ──────┘   (infra may import domain types; never services or api)
```

```
backend/
├── main.py                    app factory only (~40 lines)
├── lifespan.py                startup/shutdown wiring
├── settings.py                BackendSettings — process/env config   [was config.py]
│
├── api/
│   ├── __init__.py            aggregates all routers into one APIRouter
│   ├── deps.py
│   ├── errors.py              shared HTTPException mapping
│   ├── metadata/
│   │   ├── folders.py         folder init, fetch-from-downloads      ┐
│   │   ├── browse.py          tree, browse-path, filter-values       ├ from files.py
│   │   ├── files.py           per-file info/update/delete/readiness  ┘
│   │   ├── artwork.py  audio.py  collection.py  proxy.py
│   ├── soundcloud/
│   │   ├── auth.py            [was api/auth.py]
│   │   ├── streams.py         [from api/soundcloud.py]
│   │   ├── likes.py           [from api/soundcloud.py]
│   │   ├── playlists.py       [from api/soundcloud.py]
│   │   └── system_playlists.py
│   ├── ai.py  bpm.py  rekordbox.py  rulesets.py  profile_groups.py
│   ├── folder_config.py  app_settings.py  setup.py  suggestions.py
│
├── domain/                    PURE. no I/O, no FastAPI, no pydantic-settings
│   ├── tags/
│   │   ├── registry.py        SIMPLE_TAG_FIELDS + field defs        ┐
│   │   ├── read.py            ├ from audio/tags.py
│   │   ├── write.py           │
│   │   └── artwork.py         ┘
│   ├── titles.py              [was audio/titles.py]
│   ├── folders.py             [was audio/folders.py]
│   ├── filenames.py           [was services/filename_parser.py]
│   ├── formatting.py          [was services/list_format.py]
│   ├── rules/
│   │   └── engine.py          [was services/rule_engine.py]
│   └── suggestions/
│       ├── types.py           FieldSuggester protocol + context     ← breaks cycle
│       ├── engine.py          [was services/suggestion_engine.py]
│       ├── registry.py        REGISTRY list                         ← breaks cycle
│       └── suggesters/        artist, artwork, bpm_key, genre, mix_name, release, title
│
├── services/                  use cases; orchestrate domain + infra
│   ├── collection/
│   │   ├── indexing.py        _index_one, ensure_folder_indexed, reindex  ┐
│   │   ├── folders.py         validate/move/stats                          ├ from collection.py
│   │   └── query.py           list_and_filter_tracks, filter values        ┘
│   ├── metadata.py
│   ├── settings_store.py      settings.json load/save/update + app facade
│   │                          [merges services/settings.py + app_settings.py]
│   ├── ruleset.py  profile_group.py  folder_config.py
│   ├── ai.py                  provider-agnostic use case + Protocol
│   ├── rekordbox/             analysis, local, usb, devices, base
│   └── suggestions.py         thin orchestration over domain.suggestions
│
├── infra/                     adapters to the outside world
│   ├── db/
│   │   ├── engine.py  models.py  migrations.py
│   │   └── alembic/           env.py + versions/   (alembic.ini updated)
│   ├── cache/
│   │   ├── tracks.py          ┐
│   │   ├── peaks.py           ├ from services/cache_db.py, split by aggregate
│   │   ├── sc_bpm.py          │
│   │   └── filters.py         ┘ query/filter builder
│   ├── soundcloud/
│   │   ├── settings.py        [was backend/sc_settings.py]
│   │   ├── client.py          NEW — httpx wrapper, timeouts, error mapping
│   │   │                      (extracted from api/soundcloud.py + system_playlists.py)
│   │   ├── oauth.py           [was services/sc_oauth.py]
│   │   └── token_cache.py     [was services/sc_auth_cache.py]
│   ├── ai/
│   │   ├── anthropic.py  claude_code.py  ollama.py
│   ├── keychain.py            [was services/credentials.py]
│   └── watcher.py             [was services/watcher.py]
│
└── schemas/
    ├── api/                   wire DTOs — free to change with the frontend
    │   ├── metadata.py  tree.py  suggestions.py  auth.py  setup.py
    │   ├── soundcloud.py      ← inline models from api/soundcloud.py, system_playlists.py
    │   └── bpm.py             ← inline models from api/bpm.py
    └── config/                persisted settings.json — changing a field is a migration
        └── settings.py  ruleset.py  folder_config.py  profile_group.py  ai.py  ollama.py
```

### 2.1 Why these boundaries

- **`core/` disappears.** It carried no information — three real layers were
  hiding under it. `domain` / `services` / `infra` each answer "may this module
  do I/O?" and "who is allowed to import it?" at a glance.
- **`domain/` becomes real** and gets the ~1.9k lines that already qualify.
  Enforceable invariant: *nothing under `domain/` imports `httpx`, `sqlmodel`,
  `fastapi`, `keyring`, `pathlib` I/O, or `backend.infra` / `backend.services`.*
  That is a lint rule, not a convention.
- **`infra/` names the adapters.** Swapping Ollama for another local LLM, or the
  SQLite cache for something else, touches one directory.
- **`schemas/api` vs `schemas/config`** encodes the change-cost difference.
  `schemas/config` is the on-disk format; `AGENTS.md` says routes and keys may
  be renamed freely, but the settings file still needs load-time upgrades, so
  the two are genuinely different contracts.
- **SoundCloud gets a client.** `infra/soundcloud/client.py` owns timeouts,
  retries, redirect-host allowlisting and SC error → exception mapping once.
  Routers become thin. `services/` gains testability without HTTP route mocks.
- **Split by aggregate, not by size.** `cache_db.py` and `files.py` are split
  along the seams that already exist in them (tracks/peaks/sc_bpm;
  folders/browse/files), not chopped at an arbitrary line count.

### 2.2 What merges

| Merge | Why |
|---|---|
| `services/app_settings.py` → `services/settings_store.py` | 30-line facade over one slice of the same file; two modules for one store |
| `api/auth.py` → `api/soundcloud/auth.py` | it is SoundCloud OAuth, not generic app auth |
| `suggesters/_base.py` → `domain/suggestions/types.py` | protocol + registry split is what breaks the engine↔suggesters cycle |

### 2.3 What stays as is

`api/metadata/{artwork,audio,collection,proxy}.py`, `services/rekordbox/*`,
`alembic/versions/*` content, `api/deps.py`. The rekordbox and suggesters
subpackages are already the right shape — they are the model the rest should
follow.

---

## 3. Migration phases

Every phase is a pure move: `git mv` + import rewrite, no behavior change.
Verify after each with `uv run pytest tests/ -q`, `uv run ruff check .`,
`uv run mypy backend`, and a `uv run python -m backend.main` boot.

**Phase 0 — cleanup (no structural change).**
Delete `soundcloud_tools/`. Hoist the two unnecessary function-local imports
(`tags.py:263`, `watcher.py:162`). Rewrite the stale tree in
`docs/technical/backend.md`.
*Verify:* tests green; grep confirms no `soundcloud_tools` references.

**Phase 1 — carve out `domain/`.**
Move `core/audio/*`, `list_format`, `filename_parser`, `rule_engine`,
`suggestion_engine`, `suggesters/`. Split the suggester protocol into
`domain/suggestions/types.py` and the registry into `registry.py`, removing both
real cycles. Change `rule_engine` to take settings as a parameter instead of
importing `app_settings`.
*Verify:* tests green; `grep -rE "httpx|sqlmodel|fastapi|keyring" backend/domain`
returns nothing. Add that grep as a pre-commit hook.

**Phase 2 — carve out `infra/`.**
Move `core/db/` → `infra/db/` (update `alembic.ini script_location`),
`cache_db` → `infra/cache/` split by aggregate, `credentials` → `keychain`,
`watcher`, `sc_oauth`/`sc_auth_cache`/`sc_settings` → `infra/soundcloud/`,
AI providers → `infra/ai/`.
*Verify:* tests green; alembic `upgrade head` runs against a scratch DB;
app boots and indexes a folder.

**Phase 3 — flatten `core/services` → `services/`.**
Move remaining use cases up one level, merge `app_settings` into
`settings_store`, split `collection.py` into `indexing`/`folders`/`query`.
Delete the now-empty `core/`.
*Verify:* tests green; boot.

**Phase 4 — split `schemas/`.**
`schemas/api/` and `schemas/config/`. Pull the inline models out of `bpm.py`,
`soundcloud.py`, `system_playlists.py` into `schemas/api/`.
*Verify:* tests green; the generated OpenAPI schema is byte-identical to
before (`/openapi.json` diff) — this phase must not change the API surface.

**Phase 5 — API layer.**
Extract `infra/soundcloud/client.py` from the two routers; split
`api/metadata/files.py` into `folders`/`browse`/`files`; group the SC routers
under `api/soundcloud/`; move router registration from `main.py` into
`api/__init__.py`; move lifespan into `lifespan.py`.
*Verify:* `/openapi.json` diff again — paths and operation ids must be
unchanged; frontend e2e suite green (`npx playwright test` in `frontend/`).

**Phase 6 — mirror the tests.**
Reshape `tests/` to `tests/{domain,services,infra,api}/` matching the source
tree.
*Verify:* same test count before and after.

### 3.1 Sequencing notes

- Phases 1–4 are pure moves; each is independently revertable and reviewable.
- Phase 5 is the only one that touches request handling — it lands last and on
  its own, with the OpenAPI diff plus the Playwright suite as the gate.
- `frontend/src/generated/*` is produced from `/openapi.json`. If phases 4–5
  keep it identical, the frontend needs no change at all. That is the success
  criterion for the whole refactor: **the frontend diff is empty.**

### 3.2 Enforcing the layering afterwards

Add to `.pre-commit-config.yaml` a local hook asserting the import direction:

- `backend/domain/**` may not import `backend.services`, `backend.infra`,
  `backend.api`, nor `httpx` / `sqlmodel` / `fastapi` / `keyring`
- `backend/infra/**` may not import `backend.services` or `backend.api`
- `backend/services/**` may not import `backend.api`

Without this, the same drift recurs — that is exactly how `core/domain/` ended
up empty while `core/services/` grew to 20 modules.
