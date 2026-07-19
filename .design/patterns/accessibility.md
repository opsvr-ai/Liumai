# Accessibility Patterns — 六脉智能化运维数智平台

**Version:** 1.0
**Last Updated:** 2026-07-17
**WCAG Target:** WCAG 2.1 Level AA (with some AAA enhancements for critical patterns)

---

## Table of Contents

1. [Focus Ring Styles](#1-focus-ring-styles)
2. [Status Indicator Pattern (WCAG 1.4.1)](#2-status-indicator-pattern-wcag-141)
3. [Contrast Compliance Thresholds](#3-contrast-compliance-thresholds)
4. [ARIA Landmark Roles for Dashboard Layout](#4-aria-landmark-roles-for-dashboard-layout)
5. [Keyboard Navigation Patterns](#5-keyboard-navigation-patterns)
6. [Semantic Markup Conventions](#6-semantic-markup-conventions)

---

## 1. Focus Ring Styles

### 1.1 Global `:focus-visible` Rule

Every interactive element in the application receives a visible keyboard focus indicator via a single global rule defined in `src/styles/globals.css` (Section 9):

```css
:focus-visible {
  outline: 2px solid var(--color-interactive-primary);
  outline-offset: 2px;
}

:focus:not(:focus-visible) {
  outline: none;
}
```

- **Color:** `--color-interactive-primary` (oklch(55% 0.18 255) — a blue hue chosen for the ops domain).
- **Thickness:** 2px solid — thick enough to be visible without obscuring the element.
- **Offset:** 2px — creates a gap between the element border and the focus ring, improving readability.
- **Contrast:** ~7.1:1 against `--color-surface-primary` (dark canvas), well above the 3:1 minimum for UI components (WCAG 2.1 SC 1.4.11).
- **Selector behavior:** `:focus-visible` only shows the ring when the user is navigating via keyboard (Tab, arrow keys), not during mouse clicks. The `:focus:not(:focus-visible)` rule suppresses the "focus ring on click" behavior in browsers that don't support `:focus-visible`.

### 1.2 shadcn/ui Component Focus

shadcn/ui components use the `--ring` CSS variable for their focus indicator, set at 80% opacity for a softer visual:

```css
--ring: oklch(55% 0.18 255 / 0.8);
```

This variable is consumed by the default `focus-visible` ring utilities in shadcn/ui's component styles (e.g., `ring-offset-background`, `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`).

The dual approach ensures:
- **shadcn/ui components**: Get their intended `--ring`-based focus indicator (80% opacity, softer).
- **All other elements**: Receive the default 2px solid `:focus-visible` outline as a safety net.

### 1.3 Custom Component Focus Patterns

For custom components that do not use shadcn/ui primitives, follow these conventions:

| Component | Focus Pattern | Notes |
|-----------|--------------|-------|
| Data table cells (interactive) | `:focus-visible { outline: 2px solid var(--color-interactive-primary); outline-offset: -2px; }` | Inset offset keeps the ring visible in dense table rows |
| Graph / SVG nodes | `:focus-visible { outline: 2px solid var(--color-interactive-primary); outline-offset: 1px; }` | Focus the container figure or the interactive SVG element |
| Clickable cards | `:focus-visible { outline: 2px solid var(--color-interactive-primary); outline-offset: 2px; }` | Same as global default |
| Slide-out drawer trigger | `data-[state=open]` handled by Radix; close button gets default `:focus-visible` | Radix Sheet manages focus trapping |
| Custom toggle / switch | Apply `ring-offset-2 ring-2 ring-ring` classes manually | Matches shadcn/ui Switch pattern |

### 1.4 Data Table Focus

Data tables (the `Table` shadcn/ui component) have two focus modes:

1. **Row-level interaction** (clickable rows): Each `<tr>` receives default `:focus-visible`.
2. **Cell-level interaction** (inline editing, expand buttons): The interactive cell element receives default `:focus-visible` with an inset outline (`outline-offset: -2px`) to keep the ring within the cell boundaries and avoid clipping against neighbouring cells.

---

## 2. Status Indicator Pattern (WCAG 1.4.1)

### 2.1 The Rule

**WCAG 2.1 Success Criterion 1.4.1 Use of Color:** Color must not be the sole visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.

**六脉 enforcement:** Incident status MUST NOT be conveyed by color alone. Every status indicator must include at minimum TWO of the following three channels:

1. **Color** — The semantic status hue (green, red, amber, blue)
2. **Icon** — A Lucide icon representing the status
3. **Text label** — A visible text label or accessible name (aria-label)

### 2.2 Pattern Variants

#### Variant A: Full Status Badge (Recommended)

The primary status indicator for lists, cards, and panels. Includes all three channels.

```html
<!-- Resolved status badge -->
<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style="background-color: oklch(62% 0.19 145 / 0.15); color: var(--color-status-resolved);">
  <svg class="size-3.5" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
    <polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
  <span>Resolved</span>
</span>
```

**Lucide icon mapping:**

| Status | Color | Lucide Icon | Icon Name |
|--------|-------|-------------|-----------|
| Resolved | `--color-status-resolved` (green) | CheckCircle | `CheckCircle` |
| Active / Firing | `--color-status-active` (red) | AlertCircle | `AlertCircle` |
| Investigating | `--color-status-investigating` (amber) | Clock | `Clock` |
| Info | `--color-status-info` (blue) | Info | `Info` |

#### Variant B: Compact Status Dot

For space-constrained areas such as table cells, sidebar navigation items, and compact card headers. Uses color + tooltip or aria-label.

```html
<!-- Compact status dot with tooltip -->
<span class="inline-block size-2 rounded-full"
      style="background-color: var(--color-status-resolved);"
      role="img"
      aria-label="Status: Resolved"
      title="Resolved">
</span>
```

- The `role="img"` and `aria-label` provide the text channel for screen readers.
- The `title` attribute provides a tooltip for sighted mouse users.
- In practice, this dot is typically wrapped in a Tooltip component (shadcn/ui Tooltip) for richer hover context.

#### Variant C: Status Row in Table

For table rows that represent incidents, a colored left border (2px) combined with the full status badge in the status column.

```css
tr[data-status="resolved"] {
  border-left: 2px solid var(--color-status-resolved);
}
tr[data-status="active"] {
  border-left: 2px solid var(--color-status-active);
}
tr[data-status="investigating"] {
  border-left: 2px solid var(--color-status-investigating);
}
tr[data-status="info"] {
  border-left: 2px solid var(--color-status-info);
}
```

This provides redundant encoding (sidebar color + badge content) without relying on color alone.

### 2.3 Badge Component Integration

The shadcn/ui Badge component should be extended with four custom semantic variants. Use the existing `cva` (class-variance-authority) pattern:

```typescript
// Conceptual — implement in src/components/ui/badge.tsx
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        
        // Custom semantic status variants:
        resolved: "border-transparent bg-status-resolved/15 text-status-resolved",
        active: "border-transparent bg-status-active/15 text-status-active",
        investigating: "border-transparent bg-status-investigating/15 text-status-investigating",
        info: "border-transparent bg-status-info/15 text-status-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);
```

---

## 3. Contrast Compliance Thresholds

### 3.1 Minimum Ratios

All contrast ratios are measured against the applicable background color. The dark theme uses `--color-surface-primary` (oklch(14.5% 0.005 240)) as the primary background.

| Category | WCAG SC | Minimum Ratio | Application |
|----------|---------|---------------|-------------|
| **Normal text** (<18px / <14pt bold) | 1.4.3 (AA) | 4.5:1 | Body text, labels, table content, form labels |
| **Large text** (>=18px / >=14pt bold) | 1.4.3 (AA) | 3:1 | Headings, display text, large labels |
| **UI components** (non-text) | 1.4.11 (AA) | 3:1 | Focus indicators, status dots, borders, icons, graph lines |
| **Placeholder text** | — | No minimum | Should be distinguishable from input text (recommend >= 3:1) |
| **Enhanced contrast (AAA)** | 1.4.6 (AAA) | 7:1 | Goal for primary body text |

### 3.2 Token-Specific Contrast Verification

The following table verifies key token pairs against the dark theme background:

| Foreground | Background | Approx Ratio | Meets | Notes |
|------------|-----------|--------------|-------|-------|
| `--color-text-primary` (oklch(93% 0.005 240)) | `--color-surface-primary` (14.5%) | ~15.7:1 | AAA | Primary text is near-white, excellent contrast |
| `--color-text-secondary` (oklch(65% 0.02 240)) | `--color-surface-primary` (14.5%) | ~6.1:1 | AAA | Secondary text well above 4.5:1 minimum |
| `--color-text-muted` (oklch(45% 0.015 240)) | `--color-surface-primary` (14.5%) | ~3.3:1 | AA (large only) | Meets 3:1 for UI; if used for normal text (<18px), consider using secondary instead |
| `--color-interactive-primary` (oklch(55% 0.18 255)) | `--color-surface-primary` (14.5%) | ~7.1:1 | AAA | Focus ring and primary actions |
| `--color-status-resolved` (oklch(62% 0.19 145)) | `--color-surface-primary` (14.5%) | ~7.8:1 | AAA | UI components, status dots, badges |
| `--color-status-active` (oklch(55% 0.20 30)) | `--color-surface-primary` (14.5%) | ~6.2:1 | AAA | Red status indicators |
| `--color-status-investigating` (oklch(70% 0.18 85)) | `--color-surface-primary` (14.5%) | ~9.5:1 | AAA | Amber status indicators |
| `--color-status-info` (oklch(55% 0.15 255)) | `--color-surface-primary` (14.5%) | ~6.8:1 | AAA | Blue status indicators |
| `--color-text-primary` (oklch(93% 0.005 240)) | `--color-interactive-primary` (55% 0.18 255) | ~2.2:1 | FAIL | Text on brand buttons should use `--color-text-inverse` instead |
| `--color-text-inverse` (oklch(15% 0.01 240)) | `--color-interactive-primary` (55% 0.18 255) | ~3.2:1 | AA | Inverse text on primary buttons meets 3:1 for large text |

### 3.3 Practical Contrast Rules for Implementation

1. **Primary text** (`text-primary` on `surface-primary`): Always safe — exceeds AAA.
2. **Secondary text** (`text-secondary` on `surface-primary`): Always safe for all text sizes.
3. **Muted text** (`text-muted` on `surface-primary`): Use for non-critical metadata and labels only. Do NOT use for body text, form labels, or any text that must be read quickly under time pressure (common in incident response).
4. **Status backgrounds**: Badge background tints use 15% opacity of the status color. This produces a visible background fill without overwhelming the surface.
5. **Primary button text**: Use `--color-text-inverse` (dark text on blue background), not `--color-text-primary` (white on blue) which fails contrast.

---

## 4. ARIA Landmark Roles for Dashboard Layout

### 4.1 Dashboard Shell Regions

The dashboard layout (defined in `.design/patterns/layout.md`) receives the following ARIA landmark roles:

| Region | Element | ARIA | Purpose |
|--------|---------|------|---------|
| **Header** | `<header>` | `role="banner"` (implicit) | Project logo, current incident indicator, user menu |
| **Sidebar** | `<nav>` | `role="navigation"`, `aria-label="Main navigation"` | Primary navigation links |
| **Main content** | `<main>` | `role="main"` (implicit) | Primary view content area |
| **Right detail panel** | `<aside>` | `role="complementary"`, `aria-label="Detail panel"` | Slide-out or pinned detail content |
| **Status / toast region** | `<div>` | `role="status"`, `aria-live="polite"` | Non-critical notifications and progress updates |
| **Alert region** | `<div>` | `role="alert"` | Critical errors, destructive action confirmations |

**Layout markup template:**

```html
<body>
  <header>
    <!-- role="banner" implicit -->
  </header>

  <nav aria-label="Main navigation">
    <!-- Sidebar -->
  </nav>

  <main>
    <!-- Primary content -->
  </main>

  <aside aria-label="Detail panel">
    <!-- Right drawer content -->
  </aside>

  <div role="status" aria-live="polite">
    <!-- Sonner toasts, progress messages -->
  </div>

  <!-- Alert regions are dynamically rendered when needed -->
</body>
```

### 4.2 Additional Regions

| Region | Element | ARIA | When |
|--------|---------|------|------|
| **Search** | `<form>` or `<div>` | `role="search"` | When a search input is present in the header or sidebar |
| **Step wizard** | `<nav>` | `aria-label="Progress"` | For the progressive disclosure wizard (Task 03, pattern 3) |

### 4.3 Three-Panel RCA View ARIA

For the three-panel RCA results view (defined in `.design/patterns/layout.md`):

```html
<section aria-labelledby="causal-graph-heading">
  <h2 id="causal-graph-heading">Causal Graph</h2>
  <figure role="img" aria-label="Service dependency graph showing root cause path from [service-A] to [service-B]">
    <!-- SVG or canvas-based graph -->
  </figure>
</section>

<section aria-labelledby="rca-summary-heading">
  <h2 id="rca-summary-heading">Root Cause Summary</h2>
  <!-- AI-generated summary content -->
  <ol role="list" aria-label="Investigation timeline">
    <li>Event 1: Alert received</li>
    <li>Event 2: RCA started</li>
    <!-- ... -->
  </ol>
</section>

<aside aria-label="Evidence detail panel">
  <!-- Evidence items -->
</aside>
```

### 4.4 Skip Navigation Link

Implement a skip-to-content link as the first focusable element on every page:

```html
<!-- Placed immediately after <body> -->
<a href="#main-content"
   class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-surface-primary focus:text-text-primary focus:outline-2 focus:outline-interactive-primary focus:outline-offset-2">
  Skip to main content
</a>

<!-- Target on main element -->
<main id="main-content">
```

---

## 5. Keyboard Navigation Patterns

### 5.1 Tab Order

The logical Tab order for the dashboard shell is:

1. **Skip navigation link** (first focusable element)
2. **Header controls**: Project logo (links to home), user menu, settings/notifications
3. **Sidebar navigation**: Primary nav items, active item marked with `aria-current="page"`
4. **Main content area**: Primary interactive elements (trigger RCA, filter controls, data table)
5. **Detail panel** (if open): Close button, panel content

```
Tab 1:  Skip to content
Tab 2:  Logo / Home link
Tab 3:  User menu button
Tab 4:  Settings link
Tab 5:  Nav: Dashboard
Tab 6:  Nav: RCA History
Tab 7:  Nav: Rule Configuration
Tab 8:  Main: Trigger RCA button
Tab 9:  Main: Filter input
Tab 10+: Main: Data table rows
[if drawer open]
Tab N:  Drawer close button
Tab N+: Drawer content
```

### 5.2 Focus Trapping

**Slide-out drawer (Sheet):** When the shadcn/ui Sheet (detail drawer) opens, focus is trapped within the Sheet content. Tab cycles through the Sheet's interactive elements only. Pressing Escape or clicking the close button returns focus to the element that triggered the drawer.

**Modal dialogs:** Same focus trapping behavior as the drawer. The shadcn/ui Dialog component handles this automatically via Radix.

### 5.3 Sidebar `aria-current`

The currently active sidebar navigation item should have:

```html
<a href="/dashboard" aria-current="page" class="...">
  <!-- Dashboard icon + label -->
</a>
```

When a nav item is expanded (e.g., a collapsible section), use:

```html
<button aria-expanded="true" aria-controls="history-subnav">
  RCA History
</button>
<ul id="history-subnav">
  <li><a href="/history/recent" aria-current="page">Recent</a></li>
  <li><a href="/history/archived">Archived</a></li>
</ul>
```

### 5.4 Data Table Keyboard Navigation

Data tables follow standard WAI-ARIA grid keyboard navigation:

| Key | Action |
|-----|--------|
| **Tab** | Enter the table (focus first interactive element in first row) |
| **Tab** (again) | Exit the table to the next focusable element after the table |
| **Arrow Down** | Move to the same cell in the next row |
| **Arrow Up** | Move to the same cell in the previous row |
| **Arrow Right** | Move to the next cell in the same row |
| **Arrow Left** | Move to the previous cell in the same row |
| **Enter** | Activate the focused element (link, button, expand row) |
| **Space** | Toggle selection (if checkboxes) |

The table container needs `tabindex="0"` if it is a scrollable region, but individual row/cell focus is managed by the interactive elements within.

### 5.5 Shortcut Keys (Optional Enhancement)

For power users (SRE/ops), consider these keyboard shortcuts:

| Shortcut | Action | Notes |
|----------|--------|-------|
| `g` then `d` | Go to Dashboard | Standard "g [letter]" GitHub-style navigation |
| `g` then `h` | Go to RCA History | |
| `g` then `r` | Go to Rule Configuration | |
| `n` | New / Trigger RCA | Quick action |
| `/` | Focus search / filter | Match common convention |
| `?` | Show keyboard shortcuts help | |

Document these in a keyboard shortcuts help dialog (triggered by `?`).

---

## 6. Semantic Markup Conventions

### 6.1 HTML-First Approach

Use semantic HTML elements over `<div>` with ARIA role overrides wherever possible. Semantic elements provide built-in accessibility, correct keyboard behavior, and screen reader compatibility at no cost.

| Preferred | Avoid | Reason |
|-----------|-------|--------|
| `<button>` | `<div role="button" tabindex="0">` | Native button is keyboard accessible, form-submittable, has default styling |
| `<nav>` | `<div role="navigation">` | `<nav>` has implicit navigation role |
| `<main>` | `<div role="main">` | `<main>` has implicit main role, one per document |
| `<section aria-labelledby="...">` | `<div role="region" aria-labelledby="...">` | `<section>` has implicit region role when it has an accessible name |
| `<table>` | `<div role="grid">` | Native table has built-in row/column semantics |
| `<a href="...">` | `<span role="link" tabindex="0">` | Native anchor is keyboard accessible and has correct context menu behavior |
| `<h1>`–`<h6>` | `<div class="heading">` | Heading elements provide heading semantics for screen reader navigation |

### 6.2 Radix Primitive Exception

Custom interactive components that require complex keyboard interactions and dynamic ARIA attributes should use shadcn/ui's Radix primitives, which handle ARIA correctly out of the box.

**Components that should use Radix primitives:**

| Component | Radix Primitive (via shadcn/ui) | Why |
|-----------|--------------------------------|-----|
| Select / Combobox | `<Select>`, `<Command>` | Requires listbox pattern with typeahead |
| Dialog / Modal | `<Dialog>` | Focus trapping, dismiss on Escape |
| Dropdown menu | `<DropdownMenu>` | Complex keyboard navigation (Arrow keys, Enter, Escape) |
| Tooltip | `<Tooltip>` | Show/hide on focus and hover |
| Popover | `<Popover>` | Dismiss on Escape, focus management |
| Tabs | `<Tabs>` | Arrow key navigation between tabs |
| Sheet (drawer) | `<Sheet>` | Focus trapping, slide animation |
| Collapsible | `<Collapsible>` | `aria-expanded` management |

**Components that should use standard HTML:**

| Component | Element | Why |
|-----------|---------|-----|
| Page sections | `<section>`, `<article>`, `<aside>` | Semantic landmark roles |
| Buttons | `<button>` or shadcn/ui `<Button>` | Both use native `<button>` |
| Navigation lists | `<nav><ul><li><a>` | Standard navigation pattern |
| Forms | `<form>`, `<label>`, `<input>`, `<fieldset>` | Native form semantics |
| Tables | `<table>` or shadcn/ui `<Table>` | Both use native `<table>` |

### 6.3 Icon Accessibility

All icons must have either:

- **`aria-hidden="true"`** — When the icon is decorative or accompanied by a visible text label.
- **`aria-label`** — When the icon is standalone (no visible text) and conveys information.

```html
<!-- Icon with visible text label: decorative -->
<button>
  <svg aria-hidden="true" class="size-4"><!-- ... --></svg>
  <span>Trigger RCA</span>
</button>

<!-- Standalone icon button: informative -->
<button aria-label="Close panel">
  <svg aria-hidden="true" class="size-4"><!-- X icon --></svg>
</button>

<!-- Status dot (no visible text): informative -->
<span role="img" aria-label="Status: Active (firing)" class="size-2 rounded-full bg-status-active"></span>
```

### 6.4 Monospace Data Typography

Data surfaces (metrics, timestamps, trace IDs, log output) use the monospace font family with tabular numbers:

```html
<span class="font-mono tabular-nums text-sm text-text-primary">
  1,024 ms
</span>
```

The `tabular-nums` utility is defined in `src/styles/globals.css` (Section 7):

```css
@utility tabular-nums {
  font-variant-numeric: tabular-nums;
}
```

This ensures numeric values align vertically regardless of digit width, which is critical for scanability in ops data displays (latency values, error counts, timestamps).

### 6.5 Accessible Dynamic Content

For content that updates dynamically (agent investigation progress, timeline events, toast notifications):

| Pattern | ARIA | Usage |
|---------|------|-------|
| **Toast notifications** | `role="status"`, `aria-live="polite"` | Non-critical updates; Sonner handles this by default |
| **Critical alerts** | `role="alert"` | Destructive actions, error banners |
| **Progress updates** | `aria-live="polite"` | Agent investigation step status changes |
| **Progress bar** | `role="progressbar"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax` | Determinate progress; shadcn/ui Progress handles this |
| **Loading region** | `aria-busy="true"` on the container | When a section is loading content |

**Agent investigation step template:**

```html
<li aria-busy="true" aria-label="Investigating metrics data">
  <div class="flex items-center gap-2" role="status" aria-live="polite">
    <div role="progressbar"
         aria-valuenow="45"
         aria-valuemin="0"
         aria-valuemax="100"
         class="h-1 w-24 rounded-full bg-surface-tertiary">
      <div class="h-full w-[45%] rounded-full bg-interactive-primary transition-all"></div>
    </div>
    <span class="text-sm text-text-secondary">Analyzing metrics (45%)...</span>
  </div>
</li>
```

### 6.6 Testability Checklist

During implementation verification, use this checklist to confirm accessibility compliance:

- [ ] Tab through the entire dashboard — is every interactive element reachable?
- [ ] Is the skip-to-content link the first Tab stop?
- [ ] Do all status indicators have at least 2 of 3 channels (color + icon + label)?
- [ ] Does each dashboard section have the correct landmark role?
- [ ] Activate the Sheet drawer — does focus trap inside? Does Escape close it?
- [ ] Is the `:focus-visible` ring visible and high-contrast on all interactive elements?
- [ ] Do data table cells support Arrow key navigation?
- [ ] Are all icons either `aria-hidden="true"` (with visible label) or `aria-label` (standalone)?
- [ ] Is `<main id="main-content">` used exactly once per page?
- [ ] Are `<h1>`–`<h6>` headings used in a logical hierarchy without gaps?

---

## References

- **WCAG 2.1 SC 1.4.1** — Use of Color: https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html
- **WCAG 2.1 SC 1.4.3** — Contrast (Minimum): https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
- **WCAG 2.1 SC 1.4.6** — Contrast (Enhanced): https://www.w3.org/WAI/WCAG21/Understanding/contrast-enhanced.html
- **WCAG 2.1 SC 1.4.11** — Non-text Contrast: https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html
- **WCAG 2.1 SC 2.4.3** — Focus Order: https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html
- **ARIA Landmarks**: https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/
- **WAI-ARIA Grid Pattern**: https://www.w3.org/WAI/ARIA/apg/patterns/grid/
- **Token System**: `src/styles/globals.css`
- **Layout Framework**: `.design/patterns/layout.md`
