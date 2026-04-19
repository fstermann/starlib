---
name: styling
description: How-to for non-trivial UI/styling work in starlib. Use when adding or changing component visuals, layout chrome, tokens, themes, or anything touching globals.css, tailwind utilities, or files under src/components/ui/*.
---

# Styling

This skill is the procedural companion to `DESIGN.md` (repo root). DESIGN.md is the declarative spec — what the tokens, components, and layout should be. This skill is the how-to — what to do before, during, and after a styling change.

If the two ever disagree, DESIGN.md wins and this skill gets updated.

## Before you touch anything

1. **Read the relevant DESIGN.md section.** Tokens live in §2, type in §3, spacing §4, radii §5, components §9, layout §10. Cite the section in your response so the user can verify you're working from the spec, not from training-data intuition.
2. **Check `frontend/src/app/globals.css`.** Primitive tokens (`--surface-*`, `--text-*`, `--brand*`, `--border*`) and their shadcn aliases live there. If the token you want doesn't exist, either DESIGN.md covers it (add the token per §2) or you're about to invent a new one — stop and raise it.
3. **Open `/design`** (the in-app showcase at `frontend/src/app/design/page.tsx`) for any visual changes. It is the fastest way to see what tokens and components actually look like together across light + dark.

## While you work

- **Use primitive tokens in new code.** `bg-[var(--surface-2)]`, `text-[var(--text-muted)]`, etc. shadcn alias names (`bg-background`, `text-muted-foreground`) stay legal only inside `src/components/ui/*` — those files are shadcn-sourced and left alone.
- **Never introduce a token inside a component file.** Tokens live in `globals.css`. If you find yourself writing a one-off `oklch(...)`, stop.
- **Never hand-pick hexes for UI color.** Derive from the three knobs (`--base-hue`, `--accent-hue`, `--contrast`) per §2.2. Hexes exist in DESIGN.md only as human-readable annotations on OKLCH values.
- **Match existing density.** 28px controls, 40px table rows, 44px top bar, 56px sidebar rail (§4, §10). Don't invent arbitrary paddings (`p-[11px]`) in committed code.
- **One primary per view.** Button variant `default` is for the single primary action (§9.1). `secondary` is the default choice for most actions.
- **Respect the accent.** `--brand` solid goes on primary action + focus ring only. Selected/active state uses `--brand-soft`. Never paint large regions with `--brand` itself. Never apply the accent to decoration, dividers, or non-"current" status (§9.8).
- **Borders before shadows.** Use `--border` for separation (§6). Shadows (§7) are for floating layers only.
- **Motion ≤ `--dur-4` (320ms).** Longer is decoration, not confirmation (§8). Honor `prefers-reduced-motion`.

## Verify before reporting done

- [ ] Run `npm run dev` in `frontend/` and visually check the change in light **and** dark mode.
- [ ] Check the change in `/design` if it touches tokens or a primitive used broadly.
- [ ] Check every view that renders the changed component (grep for imports). Table changes in particular bleed into `/library` (both filesystem and SoundCloud sources) and `/weekly`.
- [ ] Type-check: `npm run typecheck` (or whatever the repo uses). Typecheck clean is the floor, not the ceiling — type correctness is not visual correctness.
- [ ] If DESIGN.md implementation drifted to match what you wrote (rather than the other way around), update DESIGN.md in the same change. Do not leave the spec stale.

## When the spec is wrong

DESIGN.md is prescriptive, not a straitjacket (§12). If you find yourself breaking a rule in three places, the rule is wrong — update DESIGN.md. If you break a rule once because of a legitimate constraint (third-party embed, user research finding, marketing surface), document it in the change that breaks the rule.

## What NOT to do

- Don't refactor adjacent styling that isn't broken. Surgical changes only.
- Don't "improve" shadcn primitives in `src/components/ui/*` — they use shadcn's token vocabulary by design.
- Don't add a new color, radius, duration, or density step without updating DESIGN.md in the same change.
- Don't rely on screenshots alone for dark-mode verification — toggle the theme and look.
