# Backend restructure — record

The restructure described here has been carried out. This file keeps the parts
that outlive it: why the layout is what it is, where the plan was wrong, and
what it uncovered. The layout itself is documented in `backend/README.md` and
`docs/technical/backend.md`; the rules are enforced by
`scripts/check_layering.py`.

---

## 1. What the package looked like

89 modules, ~12.7k lines, arranged as `api/` + `schemas/` + a `core/` that held
everything else. Layering direction was already fine — no `core → api` edges.
The problems were cohesion and naming:

- **`core/domain/` was empty** (one docstring) while ~1.9k lines of pure,
  I/O-free logic sat in `core/services/` and `core/audio/`.
- **`core/services/` was a grab bag** — 20 flat modules mixing infrastructure
  adapters, use cases, pure domain logic and config persistence. `core/` itself
  carried no information: everything that wasn't `api` lived under it.
- **Four unrelated settings concepts**, two of them loose at the package root
  (`config.py`, `sc_settings.py`), plus a `settings.json` store and a facade
  over one slice of it. Two different classes named `Settings`.
- **SoundCloud HTTP lived inside routers** — two of them each built their own
  `httpx.AsyncClient`, timeout constant, base URL and auth header. No client
  module existed.
- **Two real import cycles** patched with function-local imports, plus two more
  deferred imports that were never needed.
- **Oversized modules**: `api/metadata/files.py` (1018), `core/audio/tags.py`
  (690), `cache_db.py` (668), `collection.py` (593).
- **`soundcloud_tools/`** was dead — only `__pycache__` remained.
- **`tests/`** was flat and did not mirror anything.

## 2. The layout it became

Four rings, dependencies pointing inward: `api → services → domain`, with
`infra` holding the adapters and `schemas` layer-neutral.

```
backend/
  main.py            app factory (149 -> 91 lines)
  lifespan.py        startup/shutdown
  config.py          BackendSettings

  api/               routers only; __init__.py aggregates all of them
    metadata/        folders · browse · files · artwork · audio · collection · proxy
    soundcloud/      auth · tracks · system_playlists

  domain/            pure: no I/O, no frameworks
    tags.py          tag registry, StarlibMeta, TrackInfo
    titles.py  filenames.py  formatting.py
    suggestions/     types · engine · registry · suggesters/

  services/          use cases
    collection/      indexing · folders · query
    metadata.py  rules.py  ruleset.py  profile_group.py
    folder_config.py  app_settings.py  rekordbox/

  infra/             adapters
    db/              engine · models · migrations · alembic/
    cache.py         SQLite derived-data cache
    audio/           track_handler (mutagen + ffmpeg) · folders
    soundcloud/      client · oauth · token_cache · settings
    ai/              anthropic · claude_code · ollama
    settings_store.py  keychain.py  watcher.py

  schemas/           Pydantic contracts
```

Notable moves and splits:

| Change | Reason |
|---|---|
| `core/audio/tags.py` split | Its two halves were unrelated: the tag registry + `TrackInfo` are pure (`domain/tags.py`); `TrackHandler` is a mutagen/ffmpeg adapter (`infra/audio/track_handler.py`). |
| `api/metadata/files.py` split 1021 → 161/457/393 | Three jobs in one file: library layout, browsing, per-file CRUD. |
| `collection.py` split 594 → 3 modules | Indexing / folder ops / querying, along seams already in the file. |
| `suggestion_engine` → `domain/suggestions/{types,engine,registry}` | The engine defined the protocol *and* imported its own registry. Splitting the protocol out makes the dependency one-way and removes both cycles. |
| `sc_settings.py` → `infra/soundcloud/settings.py` | It is the SC adapter's config; five routers were importing it from the package root. |
| `settings.py` → `infra/settings_store.py` | It is a file-backed store, i.e. persistence. Keeping it in `services` forced the AI adapters into an outward import. |
| new `infra/soundcloud/client.py` | The transport the two routers were each reimplementing. |

## 3. Where the plan was wrong

Three things did not survive contact with the code. Recorded because the
reasoning matters more than the original plan did:

- **`cache_db.py` was not split by aggregate.** Its three tables share one query
  builder, and ~75 call sites monkeypatch its functions by name in tests.
  Splitting would have fragmented a cohesive repository and churned every
  patch target for no gain. It moved whole, to `infra/cache.py`.
- **`schemas/` was not split into `api/` vs `config/`.** The intent was to
  separate wire DTOs from the persisted `settings.json` format, which have
  opposite change costs. But `ai.py`, `ruleset.py` and `profile_group.py` each
  mix both *inside one module* — the boundary doesn't fall between modules.
  Grouping by feature is the better fit. What was done instead: the three
  routers that declared their models inline (`bpm`, `soundcloud`,
  `system_playlists`) now use `schemas/` like every other router.
- **`app_settings.py` was not merged into the settings store.** Both expose
  `load()`/`save()` over different shapes; merging would collide. The store was
  renamed instead, which is what actually fixed the "which `Settings`?" problem.

## 4. What it uncovered

- **Dead code — since removed.** Splitting the big modules made 21 unreferenced
  functions visible, and a name-usage scan over `backend/`, `tests/` and
  `scripts/` found the rest. All are gone: five folder helpers
  (`collect_recent_downloads`, `move_files_to_folder`, `get_folder_path`,
  `check_if_folder_has_audio`, `get_folder_stats`), `indexing.is_cache_loading`
  and `indexing.invalidate_file`, `query.filter_tracks_by_metadata` and its only
  callee `load_all_track_infos`, three metadata helpers (`get_artwork_covers`,
  `embed_artwork`, `rename_track_file`), `engine.get_db_path`, three cache
  functions (`get_distinct_folders`, `invalidate_file`, `get_all_tracks`) and
  eight leftover string helpers in `domain/titles.py`. Removal was iterated to a
  fixed point — deleting a caller orphans its callee — and the scan is empty.
- **An impurity in `domain/tags.py`.** `TrackInfo.check_artwork_url` performs a
  `requests.get` inside a pydantic validator, so constructing a `TrackInfo` with
  an `artwork_url` does network I/O. Moving the fetch to the caller is a
  behaviour change, so it was out of scope for a move-only refactor. The layering
  check permits `requests`/`mutagen` in `domain` for now; this is the reason.
- **Three outward imports** from `infra/ai/*` into `services`, caught by the
  layering check the moment it was added. Fixed by moving `settings_store`.

## 5. How it was verified

Every step: `pytest` (305 tests, green throughout), `ruff`, `mypy` and
`pydoclint` via pre-commit, plus a structural diff of the generated OpenAPI
schema against a pre-refactor baseline — paths, operations and component
schemas identical at every commit, so `frontend/src/generated/*` needs no
regeneration. Route-matching order was re-checked by resolving the ambiguous
`/folders/tree` vs `/folders/{mode}/...` paths against the live app, and
`alembic upgrade head` was run after the migrations package moved.
