# Starlib

Music management app for DJs and producers: edit local audio metadata, explore SoundCloud likes, track weekly releases from followed artists.

## Stack

| Component  | Stack                         | Directory   |
|------------|-------------------------------|-------------|
| Backend    | FastAPI · Python (uv)         | `backend/`, `soundcloud_tools/`, `starlib/` |
| Frontend   | Next.js · React · TypeScript · Tailwind v4 · shadcn | `frontend/` |
| Desktop    | Tauri v2 · Rust               | `desktop/`  |
| Docs       | Zensical (mkdocs-style)       | `docs/`     |

## Dev

```bash
uv run python -m backend.main     # backend → :8000
cd frontend && npm run dev        # frontend → :3000
```

Frontend routes: `/library` (filesystem + SoundCloud sources via `?source=`), `/weekly`, `/design` (dev-only showcase), `/auth/*`, `/setup/*`.

## Conventions

- **Python**: Google-style docstrings. Dependency/command runner is `uv`.
- **Frontend styling**: see the Design section below — `DESIGN.md` is the spec, `.claude/skills/styling/SKILL.md` is the how-to.
- **UI primitives** in `frontend/src/components/ui/*` are shadcn-sourced; leave their token vocabulary alone. Feature components use the primitive tokens from `globals.css`.
- **Package manager**: `npm` in `frontend/`, `uv` for Python, `cargo` for `desktop/`.
- **Ship model**: Starlib is a Tauri desktop app — there are no public URLs, no bookmarks, no shared deep-links. When renaming routes, URL query values, localStorage keys, or similar persisted identifiers, just rename them cleanly. Don't leave backwards-compatibility aliases, legacy key shims, or "preserve old keys so bookmarks don't break" comments — those concerns don't apply here.

## Quality gates

- **All git hooks** are managed by the Python `pre-commit` framework via `.pre-commit-config.yaml` at the repo root. Install once with `pre-commit install`. Python hooks (ruff, mypy, pydoclint) and frontend hooks (prettier, tsc) live side by side — do not introduce a second hook runner.
- **Frontend formatter**: Prettier owns all formatting. Don't hand-sort imports or Tailwind classes — `@ianvs/prettier-plugin-sort-imports` and `prettier-plugin-tailwindcss` handle both. `cn` and `cva` are registered as Tailwind functions. Config: `frontend/.prettierrc.json`.
- **Frontend scripts**: `npm run lint`, `npm run format`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`.
- **Playwright e2e** lives in `frontend/e2e/`, config in `frontend/playwright.config.ts`, fixtures in `frontend/e2e/fixtures.ts` (mocks the backend so tests don't need a running API). Run with `npx playwright test` from `frontend/`. During dev prefer a targeted run — `npm run test:e2e:changed` (only specs affected by the git diff) or a named spec — over the whole suite. The slow real-time audio specs (crossfade) are tagged `@slow`: `npm run test:e2e:fast` skips them, `npm run test:e2e:slow` runs only them.
- **CI** should run: `lint`, `format:check`, `typecheck`, `test`, `build`, and `playwright test`.

### Rule: any user-visible feature needs a Playwright test

This is binding, not aspirational. A feature that isn't exercised by an e2e test rots silently — the palette "looks the same" while its commands stop registering. Every PR that adds or changes a user-visible surface MUST include/update a Playwright spec that:

1. Mounts the feature through the normal route (no unit-level shortcuts).
2. Asserts the observable behavior (URL after navigation, dialog visible, autoplay URL hit, etc.) — not implementation details.
3. Mocks any network in `fixtures.ts` or the spec itself; tests must run offline.

Examples of "user-visible" that qualify: new routes, new palette commands/providers, new buttons in toolbars or top bar, new modal dialogs, new URL-driven behaviors (autoplay, deep-link params), new batch actions. Pure refactors and internal utilities are exempt.

If you can't reach the surface via the browser (e.g. it requires a Tauri build), say so explicitly in the PR and write the closest achievable test (e.g. rendering the page stops crashing).

# Command palette

Starlib has a global ⌘P / Ctrl+P palette in `frontend/src/components/command-palette/`. Two extension points:

- **`useCommand({...})`** — one-line hook to register a context-aware command (e.g. "Analyze selected tracks"). Lives while the calling component is mounted; auto-unregisters on unmount. Prefer this for feature-scoped actions over touching any central registry.
- **Providers** — longer-lived sources (nav, SoundCloud search, etc.) live in `command-palette/providers/*` and register via `useRegisterProvider`. Add a provider when a feature needs to contribute a *list* of items (often async/search-driven), not a single action.

Nav commands are derived from `src/lib/nav-config.ts` — adding a sidebar route or `QUICK_JUMPS` entry auto-adds a "Go to" palette entry. The palette's top-bar trigger lives in `src/components/command-palette/search-trigger.tsx`.

**Commands must be documented.** `docs/guide/command-palette.md` is the authoritative list. When you add a `useCommand({...})` or a new provider:

1. Add the id + label + gate to the table in `docs/guide/command-palette.md`.
2. Add the id (or dynamic prefix) to `KNOWN_COMMAND_IDS` / `KNOWN_COMMAND_PREFIXES` in `frontend/e2e/command-palette-catalog.spec.ts`.

The catalog spec opens the palette across several contexts, scrapes every rendered `data-command-id`, and fails CI if any id is missing from the known set — so the docs can't silently drift.

# SoundCloud API

The authoritative spec for the SoundCloud v1 API is the public OpenAPI explorer:
**https://developers.soundcloud.com/docs/api/explorer/open-api**

Raw JSON (machine-readable; same source the generate script consumes):
**https://developers.soundcloud.com/docs/api/explorer/api.json**

When in doubt about response shapes, query params, or available endpoints, consult that spec — not the locally generated types in `frontend/src/generated/soundcloud.ts`, which can lag or simplify the real schema (e.g. omitting envelope fields like a like/repost `created_at`). Trust the official spec; if the generated types are wrong, regenerate or hand-write the missing shape.

Regenerate the typed client from the upstream OpenAPI doc with:

```bash
cd frontend && npm run generate:soundcloud   # SC types only
cd frontend && npm run generate               # SC + backend types
```

# Backend

- Use Google-style docstrings.

# Design

Starlib has a single source of truth for visual design: **`DESIGN.md`** at the repo root. Read it before any UI change. It defines the OKLCH token system (three knobs → surfaces, text, brand, charts), the shadcn alias layer, typography scale, density, radii, motion, component variants, and the inverted-L layout shell.

For non-trivial styling work — new components, token changes, layout chrome, theme work, anything touching `frontend/src/app/globals.css` or files under `src/components/ui/*` — also follow the procedural guidance in **`.claude/skills/styling/SKILL.md`**. DESIGN.md is the declarative spec; the skill is the how-to.

Quick rules:
- Use primitive tokens (`--surface-*`, `--text-*`, `--brand*`) in new code. shadcn alias names stay inside `src/components/ui/*`.
- Never invent a token in a component file. Tokens live in `globals.css`.
- Visually verify in `/design` (the in-app showcase) in both light and dark before reporting done.
- If implementation drifts from DESIGN.md, update DESIGN.md in the same change.
