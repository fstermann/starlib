# Design System: Starlib

Source of truth for starlib's visual design. AI coding agents and humans should read this before making UI changes. If implementation diverges from this document, either update this document in the same change, or stop and raise it.

Advanced or non-trivial styling work should also follow the procedural guidance in `.claude/skills/styling/SKILL.md`. This document is the declarative spec; the skill is the how-to.

---

## 1. Principles

1. **Tool, not brochure.** Starlib is a workspace for people with large libraries. Density and legibility beat marketing polish. Interior screens pack information; marketing surfaces are the exception.
2. **Accent earns its moments.** Exactly one accent hue exists. It appears on active navigation, primary action, focus ring, progress, and brand marks — nowhere else. Surfaces, borders, and text stay neutral.
3. **Typography before chrome.** Hierarchy is carried by size, weight, and tracking. Decorative borders, shadows, and fills are a last resort.
4. **One formula, two themes.** Light and dark are generated from the same three tokens (`base`, `accent`, `contrast`). No hand-tuned per-theme overrides unless a token formula can't reach the needed value.
5. **Motion confirms, never entertains.** Transitions exist to make state changes legible. Durations stay under 240ms for interface motion; anything longer needs a reason.

---

## 2. Color

### 2.1 Color space

All color tokens are authored in **`oklch()`**. OKLCH is perceptually uniform: a lightness of `0.6` looks roughly equal across hues, so surface ramps and text contrast behave predictably.

Never hand-pick hexes for UI tokens. If you need a new color, derive it from the three knobs below or propose a new knob in this document.

### 2.2 The three knobs

```css
:root {
  /* Knob 1 — base hue for neutrals. Low chroma keeps surfaces timeless. */
  --base-hue: 250;        /* cool neutral; decouples from the accent */
  --base-chroma: 0.008;   /* ~invisible tint; never > 0.02 */

  /* Knob 2 — accent. Used sparingly; does not bleed into surfaces. */
  --accent-hue: 125;      /* starlib lime */
  --accent-chroma: 0.16;

  /* Knob 3 — contrast. 0 = minimum legal contrast, 1 = maximum.
     Future: bind to user preference for high-contrast mode. */
  --contrast: 0.6;
}
```

Every other color token is a formula over these three knobs plus a lightness. There are **no** hand-tuned `#hex` values in the token layer.

### 2.3 Surface ramp

Nine lightness steps, used for every elevation from page background to highest-elevation popover. Light and dark use the **same steps in reverse**.

| Token          | Role                                            | Light `L` | Dark `L` |
| -------------- | ----------------------------------------------- | --------- | -------- |
| `--surface-0`  | App canvas behind the shell                     | 0.985     | 0.115    |
| `--surface-1`  | Default page background inside content          | 0.975     | 0.145    |
| `--surface-2`  | Cards, tables, sidebar, top bar                 | 1.000     | 0.175    |
| `--surface-3`  | Inputs, table rows on hover, raised panel       | 0.965     | 0.205    |
| `--surface-4`  | Popover, menu, dialog                           | 1.000     | 0.230    |
| `--surface-5`  | Elevated popover on top of dialog               | 1.000     | 0.260    |
| `--border`     | Primary divider — the workhorse                 | 0.915     | 0.260    |
| `--border-strong` | Inputs, card outlines needing definition     | 0.880     | 0.310    |
| `--overlay`    | Dialog/drawer scrim                             | 0.145/40% | 0.020/60% |

Formula (authored as CSS):
```css
--surface-2: oklch(var(--s2-l) var(--base-chroma) var(--base-hue));
```
where `--s2-l` flips per theme. Surfaces never pick up the accent hue or chroma.

### 2.4 Text ramp

| Token              | Role                                | Light `L` | Dark `L` |
| ------------------ | ----------------------------------- | --------- | -------- |
| `--text`           | Primary body text                   | 0.205     | 0.920    |
| `--text-muted`     | Secondary text, metadata            | 0.440     | 0.700    |
| `--text-subtle`    | Placeholders, disabled, decorative  | 0.700     | 0.420    |
| `--text-on-accent` | Text on accent fill                 | 0.145     | 0.145    |
| `--text-on-danger` | Text on danger fill                 | 0.985     | 0.985    |

`--contrast` modulates the L of `--text-muted` and `--text-subtle` only. At `--contrast: 1`, both are pulled toward `--text`. Primary text is already at contrast ceiling; accent foreground is fixed dark.

### 2.5 Brand accent + state

> **Naming note.** Conceptually this is "the accent" — one of the three knobs. The CSS variable is named `--brand` (with `--brand-hover`, etc.) to avoid collision with shadcn's `--accent`, which means *hover surface* in shadcn's vocabulary (see §2.6). When this document says "the accent" it means `--brand`.

| Token            | Descriptive name        | Value (default knobs)                        | ≈ hex     |
| ---------------- | ----------------------- | -------------------------------------------- | --------- |
| `--brand`        | Lime Phosphor           | `oklch(0.78 0.16 125)`                       | `#aedc4d` |
| `--brand-hover`  | Lime Phosphor (lifted)  | `oklch(0.82 0.16 125)`                       | `#bbe85c` |
| `--brand-active` | Lime Phosphor (pressed) | `oklch(0.74 0.16 125)`                       | `#a1cf3e` |
| `--brand-soft`   | Lime Phosphor wash      | `oklch(0.78 0.16 125 / 0.12)`                | translucent |
| `--brand-ring`   | Lime Phosphor halo      | `oklch(0.78 0.16 125 / 0.50)`                | translucent |
| `--danger`       | Signal Red              | `oklch(0.64 0.19 28)`                        | `#d24a3b` |
| `--warning`      | Amber Glow              | `oklch(0.80 0.14 75)`                        | `#d8a64a` |
| `--success`      | Field Green             | `oklch(0.72 0.15 150)`                       | `#3dba7a` |
| `--info`         | Cool Steel              | `oklch(0.72 0.11 235)`                       | `#5fa6d4` |

The actual CSS uses `var(--accent-chroma)` and `var(--accent-hue)` so the values move when the knobs change; the hex column reflects the default knobs only.

Rules:
- `--brand-soft` is the only brand-tinted fill allowed on surfaces (active nav, selected row). Never paint large regions with `--brand` itself.
- Semantic colors (`danger/warning/success/info`) appear only in feedback contexts (toasts, inline validation, status dots). They are not part of the surface ramp and never replace neutrals.

### 2.6 shadcn compatibility aliases

Starlib's UI primitives in `src/components/ui/*` are shadcn-sourced. They reference a fixed token vocabulary (`--background`, `--foreground`, `--card`, `--primary`, etc.). Rather than fork those components, the design system is authored as **primitive tokens** (§2.3–§2.5) and shadcn's vocabulary is layered on top as aliases. shadcn's names are the *consumer* API; the primitives are the *source*.

```css
/* shadcn → primitives */
--background:          var(--surface-1);
--foreground:          var(--text);
--card:                var(--surface-2);
--card-foreground:     var(--text);
--popover:             var(--surface-4);
--popover-foreground:  var(--text);
--primary:             var(--brand);
--primary-hover:       var(--brand-hover);
--primary-active:      var(--brand-active);
--primary-foreground:  var(--text-on-accent);
--secondary:           var(--surface-3);
--secondary-foreground: var(--text);
--muted:               var(--surface-3);
--muted-foreground:    var(--text-muted);
/* shadcn's "accent" is a hover surface, not starlib's brand accent. */
--accent:              var(--surface-3);
--accent-foreground:   var(--text);
--destructive:         var(--danger);
--destructive-foreground: var(--text-on-danger);
--input:               var(--border-strong);
--ring:                var(--brand-ring);
/* Selected-row wash — used by table rows, menu items, nav active. */
--selected:            var(--brand-soft);
--selected-foreground: var(--text);
/* Tinted borders — replacements for `border-primary/40`, `border-destructive/40`. */
--border-brand:        oklch(0.78 var(--accent-chroma) var(--accent-hue) / 0.40);
--border-danger:       oklch(0.64 0.19 28 / 0.40);

/* Sidebar tokens derive from neutrals — never from the brand accent. */
--sidebar:                     var(--surface-2);
--sidebar-foreground:          var(--text);
--sidebar-primary:             var(--brand);
--sidebar-primary-foreground:  var(--text-on-accent);
--sidebar-accent:              var(--surface-3);
--sidebar-accent-foreground:   var(--text);
--sidebar-border:              var(--border);
--sidebar-ring:                var(--brand-ring);
```

Rules:
- New code uses **primitive names** (`--surface-2`, `--text-muted`, `--brand`). shadcn names remain legal only inside `src/components/ui/*`.
- When `npx shadcn add <component>` pulls in a new token reference, map it here; do not introduce a new primitive silently.
- `--chart-*` and `--radius` are single-source (see §2.7 and §5) and have no alias layer.

> **Implementation note:** `src/components/ui/*` components are shadcn-sourced. They use shadcn's token names by design — leave them alone. New primitives and feature components must use the primitive token names.

### 2.7 Charts

Chart series colors do **not** use the accent. They come from a distinct 5-step palette tuned for side-by-side legibility in both themes:

| Token       | Descriptive name | Value                       | ≈ hex     |
| ----------- | ---------------- | --------------------------- | --------- |
| `--chart-1` | Sky Steel        | `oklch(0.72 0.12 235)`      | `#5ba9d7` |
| `--chart-2` | Sea Moss         | `oklch(0.70 0.13 165)`      | `#3eb699` |
| `--chart-3` | Ember            | `oklch(0.72 0.14  45)`      | `#cc9159` |
| `--chart-4` | Orchid           | `oklch(0.68 0.16 305)`      | `#a877c1` |
| `--chart-5` | Olive            | `oklch(0.70 0.13 105)`      | `#9eaa49` |

---

## 3. Typography

### 3.1 Families

| Family       | Use                                                       | Source             |
| ------------ | --------------------------------------------------------- | ------------------ |
| Inter        | All sans-serif text (body, UI, headings, display)         | `next/font/google` |
| Geist Mono   | Code, commands, IDs, filenames, numerics in dense tables  | `next/font/google` |

Inter is loaded as a variable font (Inter v4) and the body sets `font-optical-sizing: auto`. The font automatically applies its display optical variant at large sizes — so headings get the tighter, more expressive optical tuning without needing a separate face. Do not import "Inter Display" as a separate family; it is unnecessary.

### 3.2 Scale

Major second (1.125) from a 14px body. Sizes in rem, multiples of 0.0625rem (1px) at 16px root.

All sans-serif rows use Inter (variable, `font-optical-sizing: auto`). At sizes ≥ 24px Inter automatically renders its display optical variant.

| Token       | px   | Weight | Line-height | Tracking   | Use                          |
| ----------- | ---- | ------ | ----------- | ---------- | ---------------------------- |
| `text-2xs`  | 9    | 600    | 1.4         | `0.06em`   | All-caps field labels inside dense editors only. Pair with `uppercase tracking-wider`. Never for prose or interactive controls. |
| `text-xs`   | 11   | 500    | 1.45        | `0.01em`   | Badges, micro-labels         |
| `text-sm`   | 12   | 500    | 1.45        | `0.005em`  | Tables, dense UI, captions   |
| `text-base` | 14   | 400    | 1.55        | `0`        | Body default                 |
| `text-md`   | 15   | 500    | 1.45        | `0`        | Controls, nav                |
| `text-lg`   | 17   | 500    | 1.40        | `-0.005em` | Card titles, tab labels      |
| `text-xl`   | 20   | 600    | 1.35        | `-0.01em`  | Section headings in-view     |
| `text-2xl`  | 24   | 600    | 1.25        | `-0.015em` | View titles (top bar)        |
| `text-3xl`  | 30   | 600    | 1.20        | `-0.02em`  | Marketing only               |
| `text-4xl`  | 40   | 600    | 1.10        | `-0.025em` | Marketing hero               |

Rules:
- Body default is **14px**, not 16px. Starlib is a dense tool; 16px leaves too little room per row.
- Never use weight 700+ in UI. Weight contrast above 600 reads as shouting on Inter Display.
- Tracking values above are optical — do not adjust them per component.

### 3.3 Monospace

Geist Mono at `text-sm` (12px) or `text-base` (14px). Never use monospace for prose. Use it for:

- Terminal commands, code blocks, JSON
- Track BPM / key / duration / file paths in dense tables
- IDs, hashes, timestamps

---

## 4. Spacing

Base unit: **4px**. Tailwind's default scale applies. Stick to these steps:

`0, 1 (4px), 2 (8px), 3 (12px), 4 (16px), 5 (20px), 6 (24px), 8 (32px), 10 (40px), 12 (48px), 16 (64px)`

Density rules:

| Context                   | Row height   | Internal padding |
| ------------------------- | ------------ | ---------------- |
| Compact table / list row  | 32px         | `px-3 py-1.5`    |
| Default table row         | 40px         | `px-3 py-2`      |
| Form field (input, select) | 28px        | `px-2.5`         |
| Button (default)          | 28px         | `px-3`           |
| Button (lg)               | 36px         | `px-4`           |
| Top bar                   | 44px         | `px-4`           |
| Sidebar item              | 32px         | `px-2`           |

Do not use arbitrary paddings (`p-[11px]`) in committed code.

---

## 5. Radii

Single knob, scale derived — matches the existing Tailwind v4 + shadcn setup in `globals.css`.

```css
--radius: 0.5rem;                          /* 8px — the one knob */
--radius-sm: calc(var(--radius) - 4px);    /* 4px — badges, tags */
--radius-md: calc(var(--radius) - 2px);    /* 6px — inputs, buttons, menu items */
--radius-lg: var(--radius);                /* 8px — cards, dropdowns, tooltips */
--radius-xl: calc(var(--radius) + 4px);    /* 12px — dialogs, sheets, major panels */
--radius-full: 9999px;                     /* avatars, toggles, pills — never on rectangular surfaces */
```

The current `--radius: 0.75rem` (12px) is too soft for dense UI; this spec lowers it to `0.5rem` (8px) so default button/input radii land at 6px. Never use `--radius-2xl` or larger on interior surfaces — heavy roundness reads as marketing.

---

## 6. Borders

One stroke weight: **1px**. Borders are the primary divider; shadows are secondary.

- `--border` for dividers, separators, unobtrusive outlines.
- `--border-strong` only where the element must be unambiguous against its surface (inputs on `--surface-2`, outlined buttons).
- Never stack a shadow on a bordered element unless the element is a floating layer (popover, dialog).

---

## 7. Shadows

Three levels. All neutral — no colored shadows.

```css
--shadow-1: 0 1px 2px 0 oklch(0 0 0 / 0.05);
--shadow-2: 0 6px 16px -4px oklch(0 0 0 / 0.10), 0 2px 4px -2px oklch(0 0 0 / 0.06);
--shadow-3: 0 18px 40px -12px oklch(0 0 0 / 0.22), 0 6px 12px -6px oklch(0 0 0 / 0.10);
```

- `--shadow-1` — hover-lift on cards. Rarely needed in-app.
- `--shadow-2` — popovers, dropdowns, tooltips.
- `--shadow-3` — dialogs, sheets, drawers.

Dark mode uses the same formulas with higher opacity (handled in one place in the theme layer).

---

## 8. Motion

```css
--dur-1: 80ms;   /* micro: checkbox, hover tint */
--dur-2: 120ms;  /* default: buttons, menu open */
--dur-3: 200ms;  /* overlay: popover, dropdown */
--dur-4: 320ms;  /* dialog enter/exit, route transition */

--ease-standard:  cubic-bezier(0.2, 0, 0, 1);
--ease-emphasized: cubic-bezier(0.3, 0, 0, 1);
--ease-exit:      cubic-bezier(0.4, 0, 1, 1);
```

Rules:
- Default to `--dur-2` + `--ease-standard`.
- Interface motion never exceeds `--dur-4`. If a transition wants to be longer, it is decoration, not confirmation.
- Respect `prefers-reduced-motion`: collapse all non-essential durations to `0ms`; keep opacity crossfades at ≤ 80ms.

---

## 9. Components

### 9.1 Buttons

Six variants — matches shadcn's shipping shape so `npx shadcn add button` keeps working. No new variants without updating this document.

| Variant       | Surface                | Text                      | Border            | Use                                        |
| ------------- | ---------------------- | ------------------------- | ----------------- | ------------------------------------------ |
| `default`     | `--brand`              | `--text-on-accent`        | none              | Reserved for marketing CTAs and confirmation dialogs |
| `secondary`   | `--surface-3`          | `--text`                  | none              | Filled neutral choice when ghost is too quiet |
| `outline`     | transparent            | `--text`                  | `--border-strong` | Alternatives to secondary on colored bgs   |
| `ghost`       | transparent            | `--text-muted` → `--text` on hover | none     | **Default for in-app actions** — toolbars, view-local primary/secondary, toggles |
| `destructive` | `--danger`             | `--text-on-danger`        | none              | Irreversible actions (delete, disconnect)  |
| `link`        | transparent            | `--brand`, underline on hover  | none         | Inline links inside prose only — never as a toolbar action |

In-app pages use **ghost everywhere**. Density and the absence of heavy fills keep the workspace feeling light. Within the ghost family, hierarchy is carried by *text color and state*, not by switching variants:

| Role              | Resting                                 | Hover                              | Disabled / inactive          |
| ----------------- | --------------------------------------- | ---------------------------------- | ---------------------------- |
| **Primary**       | `text-primary`                          | `bg-primary/10` + `text-primary`   | `text-muted-foreground/40`   |
| **Secondary**     | `text-muted-foreground`                 | `bg-[var(--surface-3)]` + `text-foreground` | `text-muted-foreground/40`   |
| **Toggle (on)**   | `text-primary` + `bg-primary/10`        | same                               | n/a                          |
| **Toggle (off)**  | `text-muted-foreground`                 | `bg-[var(--surface-3)]` + `text-foreground` | n/a                          |
| **Finalize/apply rules** | `text-emerald-600`               | `bg-emerald-600/10` + `text-emerald-600` | `text-muted-foreground/40` |

Rules:
- Each view has **one** primary action. The slot is always present in the TopBar action area; when there's nothing to do, the button stays in place but uses the disabled style. Never swap a primary out for a secondary based on state.
- `default` (solid brand fill) is reserved for marketing surfaces and the confirm button inside `AlertDialog`/destructive confirmations. It does not appear in regular in-app views.
- `destructive` is reserved for irreversible actions. Confirmation dialogs still use `destructive` for the confirm button, `secondary` for cancel.
- Minimum hit area 28×28. Sidebar rails use 36×36 because they hold only icons, no label.
- Focus ring: `0 0 0 2px var(--surface-0), 0 0 0 4px var(--brand-ring)`. Never remove it.

### 9.2 Inputs

- Height 28px, `--radius-sm`, `--surface-2` in light, `--surface-3` in dark, `--border-strong` outline.
- Focus: border becomes `--brand`, plus brand ring (same formula as buttons).
- Placeholder uses `--text-subtle`.
- Error state: border `--danger`, message below in `text-sm` `--danger`.
- Never use a filled grey input and a ring at the same time — pick one language per form.

### 9.3 Menus, popovers, tooltips

- `--surface-4`, `--border`, `--shadow-2`, `--radius-md`.
- Menu item padding `px-2.5 py-1.5`, `text-sm`, `--radius-xs`.
- Selected row uses `--brand-soft` with a left brand bar (2px) — not a full brand fill.
- Tooltip: `--surface-4` (popover), `--border`, `--shadow-2`, `--radius-md`, `text-xs`. Same family as other floating panels — not inverted.

### 9.4 Dialogs

- `--surface-4`, `--radius-lg`, `--shadow-3`.
- Overlay `--overlay`.
- Max width 560px for simple, 720px for forms, 960px only when a table or file list requires it.
- Header: `text-xl`, body `text-base`, actions right-aligned, primary rightmost.
- Enter motion: fade + `translateY(8px → 0)` at `--dur-4`.

### 9.5 Tables

Starlib's heart. Rules are strict.

- Row height 40px default (accommodates 28px cover artwork). Compact mode may drop to 32px for text-only rows.
- Column gap `px-3`. Vertical gridlines are forbidden; horizontal `--border` between rows only, and only every row — no zebra stripes.
- Header row: `text-xs`, weight 500, `--text-muted`, sentence case (no uppercase), sticky.
- Sort indicators are chevrons, not arrows; they appear only on the active column.
- Numeric columns are right-aligned with `tabular-nums`, rendered in the same sans-serif as the rest of the row. Geist Mono stays reserved for code, identifiers, and file paths — not in-table numbers, which should blend into the table's rhythm.
- Row hover: `--surface-3`. Row selected: `--brand-soft`.
- No icons in cells unless they carry meaning (play state, collection membership); never as decoration.

### 9.6 Navigation

- Sidebar active item: `--brand-soft` fill + `--brand` icon/label. No left bar, no full brand fill.
- Sidebar inactive: `--text-muted` → `--text` on hover, `--surface-3` hover fill.
- Top bar tabs (if used inside a view): underline on active, no pill fills.

### 9.7 Badges, tags, status

- `text-xs`, weight 500, `--radius-xs`, padding `px-1.5 py-0.5`.
- Neutral default: `--surface-3` fill, `--text-muted` text.
- Accent variant reserved for "active/current" state only.

### 9.8 Do / Don't

**Do**
- Use `--border` as the first choice for separation.
- Put numeric data in Geist Mono.
- Keep one primary action per view.
- Use `--brand-soft` for selected state; reserve `--brand` solid for the primary action and focus ring.

**Don't**
- Don't use drop shadows on in-flow elements to fake elevation — use `--border` or a surface step.
- Don't introduce a new token in a component file. Tokens live in `globals.css`.
- Don't mix `rounded-sm` buttons with `rounded-lg` inputs in the same view.
- Don't apply accent color to icon decoration, section dividers, or status that isn't "selected/current."

---

## 10. Layout

### 10.1 App chrome — the inverted L

```
┌──────────────────────────────────────────┐
│         │         TOP BAR (44px)         │
│ SIDEBAR ├────────────────────────────────┤
│  56px   │                                │
│ collapsed│        MAIN VIEW              │
│ 208px   │    (scrolls; padded)           │
│ expanded│                                │
│         │                                │
└──────────────────────────────────────────┘
│                  PLAYER (optional)       │
└──────────────────────────────────────────┘
```

- **Sidebar**: fixed left, 56px, icon-only. Labels surface via tooltip on hover. No hover-expand; no pinned-open mode. `--surface-2`.
- **Top bar**: fixed top, 44px, `--surface-2` with `--border` bottom. Sits to the right of the sidebar. Contains: breadcrumb/title on the left, view-local action slot on the right. No global affordances — the top bar is reserved for the current view's context.
- **Sidebar footer**: the sidebar bottom holds account/connection state and the settings gear. Theme selection lives inside Settings, not in the chrome.
- **Main view**: the only scroll container. Default padding `px-6 py-4`. No nested scroll areas except within tables and explicit panels.
- **Player**: optional, fixed bottom full-width when a track is active. Main view reserves bottom padding so nothing is obscured.

The top bar receives view-local content via a single slot pattern (to be defined in `src/components/layout/top-bar.tsx`). Views do not render their own chrome.

### 10.2 Widths

- In-app content has **no max-width** by default. Tables, boards, and lists fill the viewport.
- Form-centric views (settings, auth) cap at 640px and center.
- Marketing surfaces (if any live in-app) cap at 1120px.

### 10.3 Density

- Default density is compact. A user preference may toggle a "comfortable" density that bumps row heights and vertical rhythm by one step. Do not hard-code spacing such that a density toggle cannot reach it.

---

## 11. Accessibility

- **Contrast**: minimum WCAG AA (4.5:1 for body, 3:1 for large text and UI components). Token formulas above are tuned to pass at `--contrast: 0.6`; `--contrast: 1` targets AAA where possible.
- **Focus**: every interactive element shows the accent focus ring described in §9.1. `:focus-visible` only — no ring on mouse clicks unless also keyboard-reachable.
- **Keyboard**: every menu, dialog, and popover supports Tab, Shift-Tab, Escape, and arrow-key navigation per Radix conventions. Do not override Radix keyboard handlers.
- **Motion**: honor `prefers-reduced-motion` (§8).
- **Hit targets**: minimum 32×32 except for rail/dense contexts where 28×28 is allowed and rows/columns absorb the additional pointer area.
- **Color is never the only signal**: pair color with icon, text, or position for status.

---

## 12. When to break the rules

This document is prescriptive, not a straitjacket. Break a rule when:

- A user research finding contradicts it. Document the finding in the change that breaks the rule.
- A third-party embed (e.g. waveform, OAuth screen) cannot be re-skinned; isolate it in its own container and do not let its styling leak.
- Marketing surfaces need expressive typography or imagery that in-app density would punish. Keep marketing to `docs/` and `/` landing routes; do not import marketing components into app routes.

If you find yourself breaking a rule in three places, the rule is wrong. Update this document.
