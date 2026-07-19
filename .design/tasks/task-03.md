# Task 03 Completion Report — Layout Framework and Navigation Patterns

**Date:** 2026-07-17
**Task ID:** 03
**Type:** layout
**Wave:** 2
**Status:** COMPLETE

---

## Summary

Defined the dashboard layout skeleton, panel system, and navigation architecture for the
六脉 platform. Created comprehensive layout pattern documentation and four React layout
components: DashboardShell, RcaResultsView, RuleWizard, and IncidentTimeline.

---

## Deliverables

### 1. Layout Pattern Documentation

**File:** `.design/patterns/layout.md`

Complete documentation covering all seven layout areas:

| Section | Description |
|---------|-------------|
| Dashboard Shell Layout | Full-viewport grid, header 56-64px, sidebar 240px/56px, main content, right drawer |
| Three-Panel RCA View | 40/35/25% width ratios, collapsible panels, sticky headers |
| Progressive Disclosure Wizard | Exactly 4 steps with Back/Next + step indicator |
| Slide-Out Detail Drawer | shadcn/ui Sheet, right-anchored, Escape/click-outside/X close |
| Incident Timeline | Horizontal timeline with severity lanes |
| Responsive Breakpoints | Primary 1440px+, minimum 1024px with collapse behavior |
| Queue Position Display | RCA concurrency > 5 shows queue position (D-11) |

### 2. React Layout Components

#### `src/components/layout/dashboard-shell.tsx` — DashboardShell

Full-viewport app shell implementation:

- **Header:** 56px (`h-14`) mobile, 64px (`md:h-16`) desktop. Logo area, active incident
  counter with red badge, user menu area (extensible via `headerContent` prop).
- **Sidebar:** 240px (`w-60`) expanded, 56px (`w-14`) icon-only. Uses `transition-all
  duration-slide ease-in-out` for smooth collapse animation. Tooltip on hover for collapsed
  items. Desktop collapse toggle button at top. Footer shows version.
- **Main:** Auto-fills remaining space, scrolls independently via `overflow-auto`.
- **Right Drawer:** Optional detail panel using shadcn/ui `Sheet`, 400px width, right-anchored.
  Uses `drawerOpen`/`onDrawerClose` controlled props.
- **Layout:** CSS Grid with `grid-cols-[auto_1fr] grid-rows-[auto_1fr]`.
- **Accessibility:** `role="banner"` on header, `role="navigation" aria-label="Main navigation"`
  on sidebar, `role="main"` on content, `aria-current="page"` on active nav items.
- **Props:** `children`, `sidebarItems`, `headerContent`, `drawerContent`, `drawerOpen`,
  `onDrawerClose`, `drawerTitle`, `onHomeClick`, `activeIncidentCount`.

#### `src/components/rca/rca-results-view.tsx` — RcaResultsView

Three-panel RCA results view:

- **Layout:** CSS Grid with dynamic `gridTemplateColumns` — default 40/35/25%.
- **Left Panel (40%):** Causal graph visualization area. Sticky header with panel title
  and collapse toggle.
- **Center Panel (35%):** AI summary with `ConfidenceIndicator` component (color-coded badge
  + progress bar + percentage). Below separator, evidence timeline area.
- **Right Panel (25%):** Evidence detail area.
- **Collapse Behavior:** Each panel individually collapsible via toggle button. "Collapse all" /
  "Expand all" control in top bar.
- **Empty States:** Each panel shows contextual placeholder text when no content rendered.
- **Sticky Headers:** Each panel header uses `sticky top-0 z-10` within its scrollable
  `ScrollArea`.
- **Exports:** `RcaResultsView`, `ConfidenceIndicator`.

#### `src/components/rca/rule-wizard.tsx` — RuleWizard

4-step progressive disclosure wizard:

- **Step Indicator:** Numbered circles with connector lines. Completed steps show green
  checkmark (`CheckCircle2`). Active step highlighted with brand color. Clickable for
  review navigation.
- **Exactly 4 Steps:** Enforced via TypeScript tuple type `[WizardStep, WizardStep,
  WizardStep, WizardStep]`.
- **Navigation:** Back/Next buttons at bottom. Back disabled on step 1. Step counter
  showing "步骤 N / 4".
- **Validation:** Accepts `validationErrors` map keyed by step index. Shows destructive
  `Alert` banner with error message. Next button disabled when current step has error.
- **Cancel:** Cancel button visible on step 1 for abandoning the wizard.
- **Final Step:** "确认创建" (Confirm Create) button calls `onComplete`.
- **Accessibility:** `role="tablist"` on step indicator, `role="tab"` on each step,
  `role="tabpanel"` on content areas.
- **Exports:** `RuleWizard` component, `WizardStep` and `WizardValidation` interfaces.

#### `src/components/rca/incident-timeline.tsx` — IncidentTimeline

Horizontal timeline with severity-coded lanes:

- **Event Types:** 7 defined event types — `alert_received`, `rca_started`, `evidence_found`,
  `wecom_group_created`, `manual_finding`, `rca_completed`, `incident_resolved`.
- **Severity Lanes:** 4 severity levels — critical (red), warning (amber), info (blue),
  resolved (green). Color applied to top bar, icon background, and optional text.
- **Layout:** Horizontal scrollable `ol` with `min-w-max`. Each event card is 160-200px wide.
- **Empty State:** Shows clock icon with "暂无时间线事件" (No timeline events).
- **Auto-Scroll:** Automatically scrolls to the most recent event on mount.
- **Accessibility:** `role="region"` on container, `role="list"` and `role="listitem"`
  on events, proper `dateTime` attribute on timestamps.
- **Exports:** `IncidentTimeline`, `EmptyTimelineState`, timeline types.

### 3. Layout Token Updates

Added layout-specific CSS custom properties reference in the pattern documentation:
- `--layout-header-height`, `--layout-header-height-md`
- `--layout-sidebar-width`, `--layout-sidebar-collapsed`
- `--layout-drawer-width`, `--layout-drawer-width-min`

These are documented but not yet added to `globals.css` — they will be added in Task 07
polish if needed.

---

## Acceptance Criteria Check

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Dashboard shell: header 56-64px, collapsible sidebar 240px/56px, main content, optional right drawer | PASS | DashboardShell implements all with exact dimensions |
| 2 | Three-panel RCA view: 40/35/25% width ratios, collapsible, sticky headers | PASS | RcaResultsView with dynamic grid and individual panel collapse |
| 3 | Progressive disclosure wizard: exactly 4 steps with Back/Next + step indicator | PASS | RuleWizard with tuple-type enforcement of 4 steps |
| 4 | Slide-out drawer: shadcn/ui Sheet, right-anchored, Escape/click-outside/X close | PASS | DashboardShell uses SheetContent with all close behaviors |
| 5 | Breakpoint strategy: desktop 1440px+, minimum 1024px with collapse behavior | PASS | Documented in layout.md with Tailwind breakpoint references |
| 6 | Queue position display for concurrency exceeding D-11 default of 5 | PASS | Pattern documented with Progress bar and real-time update notes |

## Build Verification

```
vite v8.1.5 building client environment for production...

dist/index.html                   0.43 kB │ gzip:  0.33 kB
dist/assets/index-Dd1gWL7t.css   61.59 kB │ gzip: 11.22 kB
dist/assets/index-DLdfe4B8.js   190.71 kB │ gzip: 60.18 kB

✓ built in 315ms
```

No TypeScript errors, no build warnings.

## Design Decisions

1. **CSS Grid for Dashboard Shell**: Chose `grid-cols-[auto_1fr]` over flexbox for the shell
   layout because it handles the sidebar + main content area sizing more predictably and
   avoids nested flex containers for the header spanning both columns.

2. **Dynamic Grid Template Columns for Three-Panel**: Rather than toggling visibility classes,
   the RCA view computes a `gridTemplateColumns` string based on each panel's collapse state.
   Collapsed panels use `auto` (minimum content width) instead of `0` to preserve the header.

3. **Tuple Type for Wizard Steps**: Used TypeScript tuple `[WizardStep, WizardStep, WizardStep,
   WizardStep]` to enforce exactly 4 steps at compile time.

4. **Horizontal Timeline Over Vertical**: The horizontal severity-coded timeline was chosen
   over a vertical one because: (a) it maps naturally to a sequential incident lifecycle,
   (b) it allows severity lanes to be visually distinct color bars, and (c) horizontal
   scrolling in a panel is more ops-friendly for long event chains.

5. **No Drag Handle in v1**: While DESIGN-RESEARCH.md suggested drag handles for panel
   resizing, the v1 implementation uses fixed width ratios with collapse/expand toggles.
   Drag handles add significant complexity (mouse/touch event handling, bounds checking,
   storage of user preferences) and are deferred to a future refinement.

## Deviations

None. All acceptance criteria met.

## EXECUTION COMPLETE
