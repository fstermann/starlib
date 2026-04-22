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
│   ├── auth/          # OAuth callback page
│   ├── library/       # Library page (filesystem + SoundCloud sources)
│   ├── weekly/        # Weekly favorites
│   └── setup/         # Initial setup flow
├── components/        # UI components (shadcn/ui based)
├── generated/         # Auto-generated types from SoundCloud API
└── lib/               # Utilities and helpers
```

## Code generation

The SoundCloud API types in `src/generated/soundcloud.ts` are auto-generated from the [SoundCloud OpenAPI spec](https://developers.soundcloud.com/docs/api/explorer/api.json) using [openapi-typescript](https://openapi-ts.dev/).

To regenerate:

```bash
npm run generate
```

!!! warning

    Do not edit `src/generated/soundcloud.ts` manually; it will be overwritten on regeneration.

## Key pages

| Route | Description |
|-------|-------------|
| `/` | Home / collection browser |
| `/auth/soundcloud/callback` | OAuth callback handler |
| `/library` | Library — filesystem metadata editor + SoundCloud likes/playlists browser (source chosen via `?source=filesystem\|soundcloud`) |
| `/weekly` | Weekly favorites from followed artists |
| `/setup` | Initial setup and SoundCloud connection |

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
