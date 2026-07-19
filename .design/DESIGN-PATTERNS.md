---
generated: 2026-07-17T00:00:00.000Z
source_roots: (none — greenfield project, no codebase exists)
---

# Design Patterns — Existing Codebase Inventory

**Status: GREENFIELD** — No source code exists at the time of this writing. All design patterns listed below are **to be established** during implementation. This document records the intended conventions inferred from DESIGN-CONTEXT.md so the design-planner can reference them as binding targets.

---

## Existing Color Patterns

_No color tokens, CSS custom properties, or hardcoded color values exist yet. The following conventions are prescribed by DESIGN-CONTEXT.md._

| Token / Value | Status | Semantic Role | Notes |
|---|---|---|---|
| — | NOT YET DEFINED | brand primary | To be established. Dark theme baseline. |
| — | NOT YET DEFINED | surface / background | Dark theme (ops scenario). Professional, calm, trustworthy tone. |
| — | NOT YET DEFINED | status: resolved | Green accent (status-indicating). |
| — | NOT YET DEFINED | status: active/firing | Red accent (status-indicating). |
| — | NOT YET DEFINED | status: investigating | Yellow/amber accent (status-indicating). |
| — | NOT YET DEFINED | text / neutral | High readability at small sizes for terminal/ops data. |
| — | NOT YET DEFINED | accent / interactive | To be defined. |

**Inherited constraints from framework choices:**
- **shadcn/ui** provides a default dark-theme CSS custom property palette (`--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--destructive`, `--muted`, `--accent`, `--border`, `--ring`, etc.). These will be the foundation.
- **Tailwind v4** uses CSS-based theming via `@theme` directive. Custom properties defined in `@theme` become first-class Tailwind utilities.
- The visual direction mandates **dark theme as default**, with status-indicating accent colors for incident states (green=resolved, red=active, yellow=investigating).

## Existing Spacing Scale

_No spacing values exist. The following conventions are prescribed by the chosen tech stack._

| Value | Status | Notes |
|---|---|---|
| — | NOT YET DEFINED | Tailwind v4 default spacing scale (0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96) will be the foundation. |
| — | NOT YET DEFINED | shadcn/ui components ship with their own spacing conventions consistent with Tailwind defaults. |

**Inherited constraints:**
- **Tailwind v4** uses a `rem`-based spacing scale by default (1 unit = 0.25rem = 4px). The scale is 4px-step and aligns with an 8pt grid (every other step: 2 = 8px, 4 = 16px, 6 = 24px, etc.).
- Dashboards and data-dense ops UIs often benefit from a tighter grid. The planner should consider whether to customize the scale.

## Existing Typography System

_No font declarations exist. The following conventions are prescribed._

| Property | Value | Status | Notes |
|---|---|---|---|
| Font family | Sans-serif (system font stack) | RECOMMENDED | DESIGN-CONTEXT.md specifies "sans-serif, clean, good readability at small sizes." Tailwind v4 default sans-serif stack (`ui-sans-serif, system-ui, ...`) or a monospace font for terminal/ops data should be considered. |
| Font size scale | Tailwind v4 default type scale | TO BE ESTABLISHED | `text-xs` (0.75rem), `text-sm` (0.875rem), `text-base` (1rem), `text-lg` (1.125rem), `text-xl` (1.25rem), `text-2xl` (1.5rem), etc. |
| Font weight | Tailwind v4 default weights | TO BE ESTABLISHED | `font-normal` (400), `font-medium` (500), `font-semibold` (600), `font-bold` (700) likely sufficient. |
| Line height | Tailwind v4 defaults | TO BE ESTABLISHED | Tight line heights for data-dense ops views may be needed. |

**Inherited constraints:**
- **shadcn/ui** components use `font-sans` by default and define font sizes via CSS custom properties (`--font-size-sm`, `--font-size-base`, etc.) in their dark theme.
- Ops/terminal data may benefit from a **monospace font** for log output, metric values, and trace IDs. This is a likely addition beyond the base system stack.

## Existing Component Conventions

_No components exist. The following conventions are prescribed._

| Aspect | Prescribed Convention | Source |
|---|---|---|
| Styling approach | **Tailwind CSS v4** (utility-first) | DESIGN-CONTEXT.md, Frontend section |
| Component library | **shadcn/ui** (Radix UI primitives + Tailwind styling) | DESIGN-CONTEXT.md, Frontend section |
| Framework | **React with TypeScript** | DESIGN-CONTEXT.md, Frontend section |
| CSS approach | Tailwind utility classes + CSS custom properties via `@theme` | Tailwind v4 convention |
| Component authoring | shadcn/ui CLI (`npx shadcn add`) copies component source into the project | shadcn/ui convention |

**Dominant styling approach: Tailwind utility classes + shadcn/ui convention.** New components must use Tailwind v4 utility classes. Do not introduce CSS Modules, styled-components, or inline styles unless a specific shadcn/ui pattern requires it (rare).

**Component conventions to follow:**
1. All shadcn/ui components are copied to `src/components/ui/` and customized there.
2. Custom components live in `src/components/` (or feature-named subdirectories).
3. The `cn()` utility (from `tailwind-merge` + `clsx`) is used for conditional class merging — this is the shadcn/ui standard.
4. Dark theme is the default; `@theme` in the root CSS file defines the palette.
5. No CSS Modules, no styled-components, no inline style objects in application code. Style is expressed entirely through Tailwind classes and CSS custom properties defined via `@theme`.

## Planning Recommendations

**Do NOT override without explicit justification:**
- **shadcn/ui design token convention** — the established CSS custom property naming (`--background`, `--foreground`, `--primary`, etc.) must be the foundation. Adding new tokens is fine; renaming the convention is not.
- **Tailwind v4 utility-first approach** — all styling must use Tailwind utility classes. No CSS Modules or styled-components.
- **Dark theme as default** — the ops domain requires a dark-first UI. Do not build a light theme first and treat dark as an afterthought.
- **System sans-serif font stack** — do not introduce a custom font family without documented performance/readability justification.
- **Status-indicating accent colors** — green (resolved), red (active/firing), yellow (investigating) are semantically bound to incident states and must be consistent across all components.

**Safe to change (no existing usage to conflict with):**
- Everything is greenfield. The planner has full freedom to establish spacing scale customizations, custom color tokens beyond the shadcn/ui defaults, monospace font additions for terminal data, and component naming conventions.
- Tailwind v4 `@theme` customization is expected and encouraged.

**Conflicts to watch:**
- None yet — no codebase exists. However, be aware that **shadcn/ui components** and **Tailwind v4** may have overlapping customization mechanisms (CSS variables vs. Tailwind `@theme`). The planner should decide which mechanism takes precedence for custom tokens and document it.
- Hermes Agent skills and WeCom integration are backend concerns, not design patterns — they do not affect the frontend styling approach. Do not conflate agent architecture with component design.

---

## MAPPING COMPLETE
