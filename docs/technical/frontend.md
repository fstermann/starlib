# Frontend

The frontend is a **Next.js** application built with React, TypeScript, and shadcn/ui.

## Setup

```bash
cd frontend
npm install
npm run dev
```

The app is available at `http://localhost:3000`.

## Project structure

```
frontend/src/
├── app/               # Next.js app router
│   ├── layout.tsx     # Root layout
│   ├── page.tsx       # Home page
│   ├── auth/          # Login + OAuth callback pages
│   ├── library/       # Library page (filesystem, SoundCloud, Rekordbox sources)
│   ├── weekly/        # Weekly favorites
│   ├── design/        # Dev-only design system showcase
│   └── setup/         # Initial setup flow
├── components/        # UI components (shadcn/ui based)
│   ├── command-palette/  # Palette shell, useCommand hook, providers
│   ├── track-table/      # Shared table used by every library source
│   ├── track-editor/     # Metadata editor
│   ├── filters/          # Filter toolbar + per-source adapters
│   ├── columns/          # Column visibility and sorting
│   ├── rulesets/         # Ruleset editor
│   ├── tree/             # Folder / playlist tree views
│   ├── layout/           # Top bar and navigation chrome
│   └── ui/               # shadcn primitives — leave their token vocabulary alone
├── generated/         # Auto-generated types (SoundCloud + backend OpenAPI)
└── lib/               # Utilities and helpers
```

## Code generation

The SoundCloud API types in `src/generated/soundcloud.ts` are auto-generated from the [SoundCloud OpenAPI spec](https://developers.soundcloud.com/docs/api/explorer/api.json) using [openapi-typescript](https://openapi-ts.dev/).

The backend's own types in `src/generated/backend.ts` are generated the same way, from the FastAPI OpenAPI schema.

To regenerate:

```bash
npm run generate              # SoundCloud + backend
npm run generate:soundcloud   # SoundCloud only
```

!!! warning

    Do not edit anything under `src/generated/` manually; it will be overwritten on regeneration.

!!! note "The spec beats the generated types"

    The [SoundCloud OpenAPI explorer](https://developers.soundcloud.com/docs/api/explorer/open-api) is authoritative. The generated types can lag or simplify the real schema (e.g. omitting envelope fields like a like/repost `created_at`) — trust the spec and hand-write the missing shape if needed.

## Key pages

| Route | Description |
|-------|-------------|
| `/` | Home / collection browser |
| `/auth/login` | SoundCloud login entry point |
| `/auth/soundcloud/callback` | OAuth callback handler |
| `/library` | Library — filesystem metadata editor, SoundCloud likes/playlists browser, or Rekordbox collection (source chosen via `?source=filesystem\|soundcloud\|rekordbox`) |
| `/weekly` | Weekly favorites from followed artists |
| `/setup` | Initial setup and SoundCloud connection |
| `/design` | Dev-only showcase of the design system (see `DESIGN.md`) |

## Command palette

A global ⌘P / Ctrl+P palette lives in `src/components/command-palette/`. Two extension points:

### Contextual commands — `useCommand`

For feature-scoped actions, call `useCommand` from inside any component. The command is registered while the component is mounted and auto-removed on unmount.

```tsx
import { useCommand } from "@/components/command-palette";

useCommand({
  id: "playlist:create-from-selection",
  label: `Create playlist from ${selected.size} tracks`,
  group: "Actions",
  icon: ListPlus,
  when: selected.size > 0,
  run: ({ close }) => {
    openDialog();
    close();
  },
});
```

- `id` must be unique across the app (duplicates log a dev warning).
- `when` gates registration — use it instead of rendering conditionally.
- `run` is called with `{ close, query }`. Call `close()` to dismiss the palette.
- Re-registration only triggers on `id` or `when` changes; label/icon/keywords are read live from a ref, so normal re-renders don't thrash the registry.

### Providers — `useRegisterProvider`

For lists of items (nav routes, remote search results), register a `CommandProvider` in `src/components/command-palette/providers/*`:

- **`mode: "sync"`** — returns a static list; filtered client-side.
- **`mode: "async"`** — debounced; receives `(query, signal)`, honor the `AbortSignal` for cancellation. Use `minQueryLength` to avoid hitting APIs on empty input.

The `NavProvider` reads from `src/lib/nav-config.ts`, so adding a sidebar route auto-adds a "Go to" command.
