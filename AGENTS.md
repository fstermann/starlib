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

Frontend routes: `/meta-editor`, `/like-explorer`, `/weekly`, `/design` (dev-only showcase), `/auth/*`, `/setup/*`.

## Conventions

- **Python**: Google-style docstrings. Dependency/command runner is `uv`.
- **Frontend styling**: see the Design section below — `DESIGN.md` is the spec, `.claude/skills/styling/SKILL.md` is the how-to.
- **UI primitives** in `frontend/src/components/ui/*` are shadcn-sourced; leave their token vocabulary alone. Feature components use the primitive tokens from `globals.css`.
- **Package manager**: `npm` in `frontend/`, `uv` for Python, `cargo` for `desktop/`.

## Quality gates

- **All git hooks** are managed by the Python `pre-commit` framework via `.pre-commit-config.yaml` at the repo root. Install once with `pre-commit install`. Python hooks (ruff, mypy, pydoclint) and frontend hooks (prettier, tsc) live side by side — do not introduce a second hook runner.
- **Frontend formatter**: Prettier owns all formatting. Don't hand-sort imports or Tailwind classes — `@ianvs/prettier-plugin-sort-imports` and `prettier-plugin-tailwindcss` handle both. `cn` and `cva` are registered as Tailwind functions. Config: `frontend/.prettierrc.json`.
- **Frontend scripts**: `npm run lint`, `npm run format`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`.
- **CI** should run: `lint`, `format:check`, `typecheck`, `test`, `build`.

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
