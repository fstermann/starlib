# Command palette reference

This page is the **authoritative list** of every command contributed to the palette. Opening the palette (++cmd+p++ / ++ctrl+p++, or clicking **Search…** in the top bar) surfaces these — everything shown there should be documented here.

!!! info "This list is enforced"
    A Playwright test (`frontend/e2e/command-palette-catalog.spec.ts`) scrapes every command id rendered in the palette across typical contexts and asserts it matches the IDs listed below. Adding a new command without updating this table fails CI.

## Commands

Commands are grouped the same way they appear in the palette. The **When** column describes what must be true for the command to be visible — commands without a gate are always available.

### Actions

| ID | Label | When | Source |
|----|-------|------|--------|
| `settings:open` | Open Settings | always | `components/sidebar.tsx` |
| `theme:toggle` | Switch to Light/Dark Theme | always | `components/sidebar.tsx` |
| `auth:connect` | Connect SoundCloud | no SoundCloud user connected | `components/sidebar.tsx` |
| `auth:disconnect` | Disconnect SoundCloud (`<username>`) | SoundCloud user connected | `components/sidebar.tsx` |
| `sc:create-playlist-from-selection` | Create playlist from N selected tracks | on `/library?source=soundcloud`, 1 ≤ selection ≤ 500 | `app/library/soundcloud-view.tsx` |
| `sc:reload` | Reload SoundCloud library / Re-run search | on `/library?source=soundcloud` (search tab also requires a non-empty query) | `app/library/soundcloud-view.tsx` |

### Go to

Pulled from `src/lib/nav-config.ts` (`NAV_LINKS` + `QUICK_JUMPS`). Add an entry there to auto-add a palette command.

| ID | Label |
|----|-------|
| `nav:/library` | Go to Library |
| `nav:/weekly` | Go to Weekly Favorites |
| `nav:/library?source=filesystem` | Go to Library: Filesystem |
| `nav:/library?source=soundcloud&tab=me` | Go to Library: SoundCloud — My Library |
| `nav:/library?source=soundcloud&tab=discover` | Go to Library: SoundCloud — Discover |
| `nav:/library?source=soundcloud&tab=search` | Go to Library: SoundCloud — Search |

### Folders

Dynamic — one command per pinned folder shortcut. IDs are prefixed with `folder:`.

| ID pattern | Label | Source |
|------------|-------|--------|
| `folder:<path or name>` | Open folder: `<label>` | `components/command-palette/providers/pinned-folders.tsx` |

### Local Library

Async, one entry per search hit. IDs are prefixed with `local:`. Selecting a result jumps to `/library?source=filesystem&search=<query>&play=<file_path>`, which inserts your query into the filter toolbar and autoplays the track once the row is fetched.

| ID pattern | Source |
|------------|--------|
| `local:<file_path>` | `components/command-palette/providers/local-tracks.tsx` |

### SoundCloud Tracks

Async, prefixed with `sc-track:`. Selecting a result jumps to `/library?source=soundcloud&tab=search&q=<query>&play=<urn>` — your search query goes into the SC search view and the picked track autoplays as soon as it shows up in results.

| ID pattern | Source |
|------------|--------|
| `sc-track:<urn>` | `components/command-palette/providers/soundcloud-tracks.tsx` |

### SoundCloud Users

Async, prefixed with `sc-user:`. Selecting a result jumps to the Discover tab with that user preselected via `?u=<permalink>`.

| ID pattern | Source |
|------------|--------|
| `sc-user:<urn>` | `components/command-palette/providers/soundcloud-users.tsx` |

## Adding a new command

For a **contextual** command (scoped to a component's lifecycle):

```tsx
import { useCommand } from "@/components/command-palette";

useCommand({
  id: "feature:do-thing",
  label: "Do the thing",
  group: "Actions",
  icon: Wand,
  when: someCondition,
  run: ({ close }) => { doIt(); close(); },
});
```

For a **provider** (list of items, async search, etc.), add a new file under `src/components/command-palette/providers/` and mount it in `command-palette/index.tsx`. See `providers/nav.tsx` for a sync example and `providers/soundcloud-tracks.tsx` for an async one.

**Then:**

1. Add a row to the table above with the new ID, label, and gate condition.
2. If the command has a fixed ID, add it to the `KNOWN_COMMAND_IDS` set in `frontend/e2e/command-palette-catalog.spec.ts`; if the ID is dynamic (`local:*`, `sc-track:*`, etc.), add the prefix to `KNOWN_COMMAND_PREFIXES`.
3. Write a behavior test in `frontend/e2e/command-palette.spec.ts` if the command does something non-trivial on select.
