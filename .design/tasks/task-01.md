---
task: 01
type: tokens
status: complete
---

## What was done

Created the complete design token layer for 六脉 in `/src/styles/globals.css`. The file defines all color tokens (surfaces, text hierarchy, interactive/brand, semantic status, borders, overlay) using oklch values in the dark gray #1a1b1e range with no pure black, typography tokens (sans-serif + monospace font stacks, data-specific font-size at 0.8125rem, font weights, line heights), spacing/radius tokens (five radius steps), shadow tokens (three elevation levels with dark-theme-opaque shadows), and motion tokens (five durations, four easing curves). The shadcn/ui CSS variable compatibility layer is fully overridden: 18 CSS variables (`--background` through `--ring` plus `--radius`) are set in both `:root` and `.dark` selectors, with a `@theme inline` mapping block that connects shadcn Tailwind utility names to these variables. All 18 variables map to the corresponding 六脉 semantic tokens (e.g., `--primary` maps to `--color-interactive-primary`, `--destructive` maps to `--color-status-active`), documented in a mapping comment block. A `tabular-nums` utility is added for monospace data surfaces, and a `prefers-reduced-motion: reduce` override block is included.

## Files changed

- `/src/styles/globals.css`: Created — the complete design token system with all color, typography, spacing/radius, shadow, and motion tokens via `@theme`, plus shadcn/ui CSS variable overrides via `@theme inline` + `:root`/`.dark` selectors, tabular-nums utility, and reduced-motion block.

## Acceptance criteria

- [x] All surface backgrounds use dark gray values in the #1a1b1e range; no #000000 pure black appears as a surface color. (Surfaces: oklch 14.5%, 18%, 22% lightness with 240 hue — dark grays, never black.)
- [x] Semantic status tokens (resolved/active/investigating/info) are defined and use distinct hues (green/red/amber/blue). (resolved: 145 hue green, active: 30 hue red, investigating: 85 hue amber, info: 255 hue blue.)
- [x] Monospace font stack (`--font-mono`) is defined and targeted at data surfaces (metrics, timestamps, trace IDs, log output). (JetBrains Mono, IBM Plex Mono, SF Mono, ui-monospace, Cascadia Code, Source Code Pro, Menlo, Consolas — plus tabular-nums utility.)
- [x] shadcn/ui CSS variables (`--background`, `--foreground`, `--primary`, etc.) are overridden and consistent with the 六脉 dark palette. (All 18 variables in `:root` and `.dark`, with `@theme inline` mapping block — documented mapping table.)
- [x] All tokens are defined via `@theme` in the root CSS file; no `tailwind.config.js` or JS-based token overrides exist. (Single file at `/src/styles/globals.css`, `@theme` for 六脉 tokens, `@theme inline` for shadcn mapping.)

## Design choices made

- **oklch color space**: All color values use oklch() for perceptual uniformity, WCAG-friendly contrast, and straightforward dark-mode derivation. This aligns with Tailwind v4 + shadcn/ui v4 conventions.
- **Blue as interactive brand color**: Blue hue (255) at 55% lightness / 0.18 chroma chosen for professional, calm, trustworthy tone appropriate for ops/SRE domain. Avoids AI-slop palette colors (#6366f1 indigo, #8b5cf6 violet, #06b6d4 cyan).
- **Dual scoping (:root + .dark) for shadcn variables**: Both selectors defined with identical values to ensure compatibility regardless of how the framework applies the dark class — some shadcn/ui setups toggle `.dark` on `<html>`, others expect `:root`-only for dark-first themes.
- **Motion tokens included in v1**: Task 04 will refine these, but basic duration/easing tokens are defined here so downstream tasks can reference them from day one.
- **No `font-variant-numeric: tabular-nums` on `--font-mono` directly**: Rather than forcing tabular-nums on all monospace text (which affects every log line including non-numeric content), a separate `tabular-nums` utility class is provided for opt-in use on numeric data surfaces.

## Deviations (if any)

none
