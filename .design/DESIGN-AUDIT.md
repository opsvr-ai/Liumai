---
audited: 2026-07-17
total_score: 20/24
supplement_note: "Supplements 7-category 0-10 system in reference/audit-scoring.md — does not replace it"
---

## Design Audit — 六脉智能化运维数智平台

**Audited:** 2026-07-17
**Audit type:** Qualitative 6-pillar (1-4 per pillar) — SUPPLEMENTS existing 7-category 0-10 scoring
**Screenshot gap:** Code-only analysis (no Playwright-MCP or dev server screenshot capture). Visual findings are inferred from source code patterns. Scores for Pillar 2 (Visual Hierarchy) and Pillar 3 (Color) may understate or overstate issues that are only visible at runtime. Human visual inspection is recommended for these pillars.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copy | 3/4 | Chinese-specific verb-first CTAs; empty state missing action button guidance |
| 2. Visual Hierarchy | 3/4 | Clear primary/secondary structure; 2-click rule satisfied; code-only limitation on focal point assessment |
| 3. Color | 4/4 | Exemplary OKLCH token system; no AI-default palette; semantic roles strictly enforced |
| 4. Typography | 4/4 | Systematic scale; monospace + sans-serif pairing; tabular-nums on data surfaces |
| 5. Layout & Spacing | 3/4 | Consistent grid discipline; some arbitrary values not tokenized; responsive breakpoints used |
| 6. Experience Design | 2/4 | Loading states defined but unwired; empty states basic; no error boundaries or confirmation dialogs implemented |

**Overall: 20/24**

---

## Priority Fix List

Listed by impact. Top 3 fixes the verifier should weight heavily.

1. **[Pillar 6 — Experience Design: Missing state implementations]** — Operators will encounter blank screens during loading, raw error exposure on failure, and no recovery paths. The design pattern foundations exist (Skeleton, Alert, EmptyTimelineState) but none are wired to actual data-fetching states. Every async operation in the feature components (RCA trigger, history load, rule list) must show a loading skeleton, handle error states with actionable messages, and display proper empty states with next-step buttons as specified in copy.md Section 5.

2. **[Pillar 5 — Layout & Spacing: Arbitrary spacing values not tokenized]** — The drawer uses `w-[400px]` (layout.md defines 400px but no `--layout-drawer-width` token exists in globals.css), the dashboard badge uses `text-[10px]` outside the type scale, and several components use arbitrary pixel values (`min-w-[1rem]`, `min-w-[160px]`, `max-w-[200px]`) instead of referencing the Tailwind spacing scale or CSS custom properties. These should be elevated to design tokens or refactored to scale values.

3. **[Pillar 1 — Copy: Empty state copy lacks action buttons]** — The `EmptyTimelineState` component in `incident-timeline.tsx` shows only "暂无时间线事件" with an icon but no explanation of why the timeline is empty or what the operator should do next. Copy.md Section 5 specifies a three-part empty state (icon + title + description + action button). This applies to all three empty state scenarios: no RCA history, no matching alerts, no search results.

---

## Detailed Findings

### Pillar 1: Copy (3/4)

**Evidence from grep:**
- No generic English CTAs found (`"Submit"`, `"Click Here"`, `"OK"`, `"Cancel"` are absent from buttons)
- All button text is Chinese and verb-first: "取消", "上一步", "下一步", "确认创建", "触发RCA" in `rule-wizard.tsx`
- Empty state detected in `incident-timeline.tsx:167` — `"暂无时间线事件"` — a basic message with no explanation or action
- Dedicated `EmptyTimelineState` export at `incident-timeline.tsx:259` — component exists but only shows icon + minimal text
- Error messages use `Alert` component with Chinese title + description pattern (e.g., "请修正以下错误" in `rule-wizard.tsx:186`)
- Dialog close button uses English "Close" in an `sr-only` span (`dialog.tsx:75`)
- DashboardShell badge count uses `text-[10px]` — outside type scale
- No `"Something went wrong"` or `"try again"` generic error strings found
- Copy.md guidelines document is comprehensive with Chinese-specific patterns, 3-part error structure, and verb-first conventions

**Top gap:** Empty states lack the 3-part structure (icon + title + description + action button) specified in copy.md. The `EmptyTimelineState` component provides only a bare message.

### Pillar 2: Visual Hierarchy (3/4)

**Evidence from grep:**
- No `btn-primary` class or competing multiple primary CTA patterns found — each view has at most one primary button
- Heading weight differentiation: `text-xs` uppercase (panel headers), `text-sm` (body), `text-base`/`text-lg` (titles), `font-semibold` for headings, `font-medium` for nav items
- DashboardShell has a single header with logo (left), incident indicator (right), sidebar nav (left column)
- RuleWizard has clear primary action per footer (Back left, Next/Confirm right) with step counter
- Three-panel RCA view has collapsible panels with sticky headers — each panel has a clear header region
- Sidebar navigation uses `aria-current="page"` for active state, `bg-interactive-primary/10` for visual differentiation
- 2-click rule (M-09) satisfied per polish-review.md Section 1.1 — all key actions reachable within 1-2 clicks

**Limitation:** This is a code-only analysis. Focal point and reading order cannot be confirmed without a rendered view. Code analysis checks structural indicators (primary CTA count, heading weight classes) but cannot assess visual weight balance.

**Top gap:** The confidence indicator badge and panel collapse/expand controls in RcaResultsView create multiple interactive elements in close proximity — may compete for attention at runtime.

### Pillar 3: Color (4/4)

**Evidence from grep:**
- Zero matches for AI-slop palette colors (`#6366f1`, `#8b5cf6`, `#06b6d4`) anywhere in source
- All colors defined as OKLCH tokens in `src/styles/globals.css` via `@theme` — no hardcoded hex values
- Semantic status tokens (resolved/active/investigating/info) are used exclusively via CSS class references (`bg-status-resolved/10`, `text-status-active`, `bg-status-investigating`)
- `text-destructive` / `bg-destructive` classes used consistently for destructive actions across Button, Badge, Alert, DropdownMenu
- Dark mode handled via `:root .dark` block and `dark:` variants in component styles
- Polish review confirmed (Section 2): all status colors exclusive to incident states, no decorative color usage, no pure black surfaces
- One instance of hardcoded `text-white` in `dashboard-shell.tsx:127` (alert badge count on status-active background) — acceptable as it's a static foreground color paired with a dynamic background

**Top gap:** Minor — `text-white` in `dashboard-shell.tsx:127` should reference `--color-text-inverse` for token consistency, though functionally it produces the same result. Runtime color harmony cannot be confirmed without visual rendering.

### Pillar 4: Typography (4/4)

**Evidence from grep:**
- Font sizes consistently use Tailwind scale: `text-xs` (12px), `text-sm` (14px), `text-base` (16px), `text-lg` (18px) across all components
- Two font families: `--font-sans` (system sans-serif stack) and `--font-mono` (JetBrains Mono + IBM Plex Mono + SF Mono fallbacks)
- Weight hierarchy: `font-medium` (card titles, nav items), `font-semibold` (panel headers), `font-bold` (logo, badge counts)
- Line heights: `leading-relaxed` (1.5) on body summary text, `leading-tight` (1.15) on timestamps, `leading-snug` (1.3) on card titles
- Custom `tabular-nums` utility defined and used on `font-mono` spans for numeric alignment
- Monospace applied to: timestamps in timeline (`incident-timeline.tsx:218`), confidence percentage (`rca-results-view.tsx:89`)
- Type scale compliance verified by polish review (Section 3): 3 corrections applied to eliminate off-scale values
- One remaining off-scale value: `text-[10px]` in `dashboard-shell.tsx:127` (badge count) and `text-[0.8rem]` in `button.tsx:28` (shadcn default)

**Top gap:** The `text-[10px]` on the badge counter (`dashboard-shell.tsx:127`) is below the defined minimum of `text-xs` (12px) — should use `text-xs` with smaller badge dimensions.

### Pillar 5: Layout & Spacing (3/4)

**Evidence from grep:**
- DashboardShell uses CSS grid layout: `grid-cols-[auto_1fr] grid-rows-[auto_1fr]` with clear content zone separation
- Three-panel RCA view uses dynamic `grid-template-columns` with 40/35/25% ratios per layout.md
- Consistent spacing: `p-3`, `p-4`, `px-3`, `py-2`, `gap-2`, `gap-3`, `gap-1.5` — mostly adheres to 4px grid
- Responsive breakpoints: `md:` used extensively in dashboard-shell (26 occurrences), rule-wizard, and sheet
- Max-width enforcement: `sm:max-w-[400px]` on Sheet, `sm:max-w-sm` on Dialog, `max-w-[200px]` on timeline items
- Padding scales with viewport: `px-3 md:px-4`, `p-4 md:p-6`, `px-4 md:px-6`
- Sidebar dimensions: 240px (`w-60`) expanded, 56px (`w-14`) collapsed — match layout.md spec
- Drawer width: 400px (`w-[400px]`) — matches layout.md but uses arbitrary value instead of token

**Off-grid values found:**
- `dashboard-shell.tsx:255` — `w-[400px]` (drawer width — matches spec but not tokenized)
- `dashboard-shell.tsx:127` — `min-w-[1rem]` (badge minimum width)
- `incident-timeline.tsx:190` — `min-w-[160px]`, `max-w-[200px]` (timeline item dimensions)
- `dialog.tsx:56` — `max-w-[calc(100%-2rem)]` (dialog max width)
- `button.tsx:28` — `text-[0.8rem]` (shadcn default sm size)

**Top gap:** No `--layout-drawer-width` or `--layout-timeline-item-width` tokens exist in globals.css despite layout.md specifying these as token-worthy values (layout.md Section 8 defines `--layout-drawer-width: 25rem;` but it was never added to `@theme`). Arbitrary value sprawl will increase without token elevation.

### Pillar 6: Experience Design (2/4)

**Evidence from grep:**
- **Loading states:** `Skeleton` component exists at `skeleton.tsx` — defined and exported, but zero usages in any feature component. No `isLoading`/`isPending`/`loading` logic found in any component.
- **Error states:** `Alert` component with `destructive` variant exists and is used in `RuleWizard` for validation errors (`rule-wizard.tsx:184`). No `ErrorBoundary` component found. No error handling for async operations (fetch failures, API errors).
- **Empty states:** `EmptyTimelineState` exported from `incident-timeline.tsx:259`. `if (events.length === 0)` check present at `incident-timeline.tsx:162`. RcaResultsView has placeholder content but no empty state for "no results" scenario. DashboardShell has no empty state for "no items".
- **Disabled states:** `disabled={!!currentError}` in `rule-wizard.tsx:233,243`. `disabled={index > currentStep}` in `rule-wizard.tsx:121`. Button component handles `disabled:pointer-events-none disabled:opacity-50` via shadcn. No tooltips on disabled buttons as specified in copy.md.
- **Confirm/destructive:** `destructive` variant exists in Button, Badge, Alert components. Copy.md defines confirmation dialog patterns (Section 2.5) but no implementation of confirmation dialogs exists. No `confirm`/`Confirm`/`areYouSure` logic in any component.
- **ARIA live regions:** `role="alert"` used on Alert component. `role="progressbar"` with `aria-valuenow` on ConfidenceIndicator. No `role="status"` or `aria-live="polite"` regions found for dynamic updates.
- **Sonner:** Toaster configured at `sonner.tsx` with proper icon mappings and dark theme styles — ready but not wired to any event.

**Top gap:** This is the weakest pillar. The design system has all the *structural primitives* (Skeleton, Alert, EmptyTimelineState, disabled variants, destructive variants) but NOT ONE feature component wires them to actual states. This is expected given that the design stage produces pattern documentation and component primitives, not full page implementations — but the gap is significant enough that the implementation phase must prioritize state coverage. Specific missing patterns:

1. No loading/skeleton usage in any feature component for data-fetching operations
2. No ErrorBoundary at application or route level
3. No confirmation dialog before destructive actions
4. No `role="status"` regions for live updates
5. Disabled buttons lack tooltip explanations

---

## Screenshot Gap

This audit is **code-only**. No Playwright-MCP and no dev server screenshot capture was performed. The following findings are inferred from source code and may not reflect actual runtime visual quality:

- **Visual Hierarchy (Pillar 2):** Focal point and reading order cannot be confirmed without a rendered view. Code analysis checks for structural indicators (primary CTA count, heading weight classes) but cannot assess visual weight balance.
- **Color (Pillar 3):** Color palette harmony and dark mode visual quality require a rendered view. Code analysis checks for token usage and known anti-patterns but cannot assess harmony.
- **Typography (Pillar 4):** Font rendering and scale legibility require visual inspection. Code analysis checks class usage but cannot assess the rendered result.
- **Layout & Spacing (Pillar 5):** Responsive collapse behavior below 1024px (sidebar icon-only, three-panel to tabs) cannot be verified without rendering at different viewport sizes.
- **Experience Design (Pillar 6):** Loading skeleton animation quality, toast appearance, and transition smoothness require visual inspection.

**Recommendation:** Run design-verifier Phase 4 (Visual UAT) to supplement these code-only findings with human visual inspection.
