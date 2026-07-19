# Layout Pattern Documentation — 六脉 (Liumai)

> Part of the design system foundation (Task 03).
> Defines the dashboard layout skeleton, panel system, navigation architecture,
> and all core layout patterns for the 六脉 intelligent operations platform.

---

## Table of Contents

1. [Dashboard Shell Layout](#1-dashboard-shell-layout)
2. [Three-Panel RCA Results View](#2-three-panel-rca-results-view)
3. [Progressive Disclosure Wizard Pattern](#3-progressive-disclosure-wizard-pattern)
4. [Slide-Out Detail Drawer Pattern](#4-slide-out-detail-drawer-pattern)
5. [Incident Timeline Pattern](#5-incident-timeline-pattern)
6. [Responsive Breakpoint Strategy](#6-responsive-breakpoint-strategy)
7. [Queue/Position Display for RCA Concurrency](#7-queueposition-display-for-rca-concurrency)
8. [Header and Navigation Dimensions](#8-header-and-navigation-dimensions)

---

## 1. Dashboard Shell Layout

### Structure

The dashboard shell is a full-viewport layout with three primary regions:

```
┌──────────────────────────────────────────────────────┐
│ Header (56-64px fixed)                                │
│ [Logo] [Incident Indicator]               [User Menu] │
├────────┬─────────────────────────────────────────────┤
│        │                                             │
│ Sidebar│  Main Content Area (scrolls independently)  │
│ 240px  │                                             │
│ (coll. │                                             │
│  to 56)│                                             │
│        │                                             │
│        │                                     [Right] │
│        │                                     [Drawer]│
│        │                                     (Sheet) │
└────────┴─────────────────────────────────────────────┘
```

### CSS Implementation (Tailwind v4)

#### Container
```tsx
<div className="h-dvh grid grid-cols-[auto_1fr] grid-rows-[auto_1fr]">
```

#### Header (`<header role="banner">`)
```tsx
<header className="col-span-2 h-14 md:h-16 flex items-center px-4 border-b border-border bg-surface-primary z-30">
```
- Height: `h-14` (56px) on mobile, `md:h-16` (64px) on desktop
- Full width of viewport (`col-span-2` in grid)
- Fixed via `sticky top-0` or grid positioning
- Contains: logo (left), incident status indicator (center or left), user menu (right)

#### Sidebar (`<nav role="navigation" aria-label="Main navigation">`)
```tsx
<aside className="w-60 md:w-60 transition-all duration-slide ease-in-out border-r border-border bg-surface-secondary overflow-y-auto">
```
- Default width: `w-60` (240px)
- Collapsed width: `w-14` (56px) — icon-only mode
- Transition: `duration-slide` (250ms) with `ease-in-out`
- Scrollable independently via `overflow-y-auto`
- Navigation items show `aria-current="page"` on active

Collapsed state:
```tsx
<aside className="w-14 ...">
```
- Labels hidden, only icons visible
- Tooltip on hover for collapsed items (shadcn/ui Tooltip)

#### Main Content Area
```tsx
<main role="main" className="overflow-auto p-4 md:p-6 bg-surface-primary">
```
- Fills remaining horizontal and vertical space
- Independent scroll via `overflow-auto`
- Padding: `p-4` mobile, `p-6` desktop

#### Right Detail Drawer
Uses shadcn/ui `Sheet` component anchored right (see [Section 4](#4-slide-out-detail-drawer-pattern)).

### Component

The `DashboardShell` component at `src/components/layout/dashboard-shell.tsx` implements this layout.

### ARIA Landmarks

| Region | Element | ARIA |
|--------|---------|------|
| Header | `<header>` | `role="banner"` (implicit) |
| Sidebar | `<aside>` / `<nav>` | `role="navigation" aria-label="Main navigation"` |
| Main | `<main>` | `role="main"` (implicit) |
| Detail panel | `<Sheet>` | `role="complementary" aria-label="Detail panel"` |
| Alerts | `<div>` | `role="alert"` |
| Status | `<div>` | `role="status" aria-live="polite"` |

---

## 2. Three-Panel RCA Results View

### Structure

```
┌──────────────────────┬──────────────────────┬──────────────────────┐
│    Left Panel (40%)  │   Center Panel (35%) │   Right Panel (25%) │
│                      │                      │                      │
│ ┌─── Sticky Header ──┤ ┌─── Sticky Header ──┤ ┌─── Sticky Header ─┤
│ │ Causal Graph       │ │ AI Summary         │ │ Evidence Detail   │
│ │ (node-edge viz)    │ │ (confidence ind.)  │ │ (key metrics,     │
│ │                    │ │                    │ │  log excerpts,    │
│ │ Affected services  │ │ Evidence Timeline  │ │  trace IDs)       │
│ │ with severity      │ │ (agent steps)      │ │                   │
│ │ colors             │ │                    │ │                   │
│ └────────────────────┘ └────────────────────┘ └────────────────────┘
│  Collapsible          │  Collapsible          │  Collapsible       │
└──────────────────────┴──────────────────────┴──────────────────────┘
```

### Width Ratios

```tsx
<div className="grid grid-cols-[40%_35%_25%] gap-4 h-full">
```

- **Left panel (40%):** Causal graph visualization — service dependency topology with color-coded severity.
- **Center panel (35%):** AI-generated natural language root cause summary with confidence indicator, followed by evidence chain timeline.
- **Right panel (25%):** Evidence detail — key metrics, log excerpts, trace IDs that contributed to the RCA determination.

### Panel Implementation

```tsx
<section aria-labelledby="panel-left-heading" className="flex flex-col overflow-hidden border-r border-border">
  <div className="sticky top-0 z-10 bg-surface-secondary px-4 py-3 flex items-center justify-between">
    <h2 id="panel-left-heading" className="text-sm font-semibold text-foreground">
      {/* Panel title */}
    </h2>
    <button onClick={onToggle} className="text-muted-foreground hover:text-foreground">
      <ChevronLeft className="h-4 w-4" />
    </button>
  </div>
  <div className="flex-1 overflow-auto p-4">
    {/* Panel content */}
  </div>
</section>
```

### Collapse Behavior

Each panel has a collapse toggle in its sticky header:
- **Collapsed panel:** Shows only the sticky header with a narrow column (approximately `min-w-0` or `w-12`).
- Use `grid-template-columns` with `fr` units and toggle a collapsed class that sets width to `auto` or `0` with overflow hidden.
- On collapse, the remaining panels expand to fill the freed space.

```tsx
// Collapse state managed via useState<Record<PanelPosition, boolean>>
<div className={`grid grid-cols-[${leftOpen ? '40%' : 'auto'}_${centerOpen ? '35%' : 'auto'}_${rightOpen ? '25%' : 'auto'}] gap-4`}>
```

### Sticky Headers

Each panel header uses `sticky top-0` within its panel container. Because the panels themselves are in a scrollable container, the sticky context is the panel, not the page.

```css
/* Panel header — sticks to top of panel, not page */
.panel-header {
  position: sticky;
  top: 0;
  z-index: 10;
}
```

### Collapse Button (Optional Drag Handle)

For resize support, an optional drag handle can be added at the right edge of each panel:
```tsx
<div className="w-1 cursor-col-resize hover:bg-interactive-primary/20 active:bg-interactive-primary/30 transition-colors" />
```

---

## 3. Progressive Disclosure Wizard Pattern

### Structure

A 4-step wizard for configuring alert-to-RCA trigger rules (M-01).

```
Step 1 ──→ Step 2 ──→ Step 3 ──→ Step 4
[●]        [○]        [○]        [○]
Trigger     Condition   Action      Review &
Event       Config      Spec        Confirm
```

### Step Indicator Component

```tsx
// Step indicator at top of wizard
<div className="flex items-center justify-center gap-0 mb-8" role="tablist" aria-label="Rule configuration steps">
  {steps.map((step, index) => (
    <div key={step.id} className="flex items-center">
      {/* Step circle */}
      <button
        role="tab"
        aria-selected={currentStep === index}
        aria-controls={`panel-${index}`}
        onClick={() => onStepClick(index)}
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-lg transition-colors",
          currentStep === index && "bg-interactive-primary/10 text-interactive-primary",
          currentStep > index && "text-status-resolved",
          currentStep < index && "text-muted-foreground"
        )}
        disabled={currentStep < index && !allowSkipAhead}
      >
        {/* Number or checkmark */}
        {currentStep > index ? (
          <CheckCircle2 className="h-5 w-5" />
        ) : (
          <span className="flex items-center justify-center h-5 w-5 rounded-full border text-xs font-medium
            {currentStep === index ? 'border-interactive-primary bg-interactive-primary text-primary-foreground' : 'border-border'}"
          >
            {index + 1}
          </span>
        )}
        <span className="text-sm font-medium hidden md:inline">{step.label}</span>
      </button>
      {/* Connector line */}
      {index < steps.length - 1 && (
        <div className={cn(
          "w-8 md:w-16 h-px mx-2",
          currentStep > index ? "bg-status-resolved" : "bg-border"
        )} />
      )}
    </div>
  ))}
</div>
```

### The 4 Steps

| Step | Label | Description | Key UI Elements |
|------|-------|-------------|-----------------|
| 1 | Trigger/Event Spec | Select alert source, severity, service | Select, Input |
| 2 | Condition Config | Cascading provider-instance-metric menus | Cascading Select, Multi-select |
| 3 | Action Spec | Select RCA skill, WeCom group config | Select, Input, Switch |
| 4 | Review & Confirm | Summary of all settings before save | Card, Alert, Button |

### Navigation Rules

```tsx
<div className="flex justify-between mt-8 pt-6 border-t border-border">
  <Button
    variant="outline"
    onClick={onBack}
    disabled={currentStep === 0}
  >
    <ChevronLeft className="h-4 w-4 mr-1" />
    上一步 (Back)
  </Button>

  {/* Step indicator text */}
  <span className="text-sm text-muted-foreground self-center">
    步骤 {currentStep + 1} / {steps.length}
  </span>

  {currentStep < steps.length - 1 ? (
    <Button onClick={onNext}>
      下一步 (Next)
      <ChevronRight className="h-4 w-4 ml-1" />
    </Button>
  ) : (
    <Button onClick={onConfirm} variant="default">
      确认创建 (Confirm)
    </Button>
  )}
</div>
```

- **Back button:** goes to previous step, disabled on step 1.
- **Next button:** validates current step, advances if valid.
- **Step indicator clickable:** user can click completed steps to review.
- **Disabled Next:** if current step validation fails.

---

## 4. Slide-Out Detail Drawer Pattern

### Implementation

Uses the shadcn/ui `Sheet` component (from `@/components/ui/sheet`):

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"

<Sheet open={isOpen} onOpenChange={onClose}>
  <SheetContent side="right" className="w-[400px] sm:max-w-[400px] p-0">
    <SheetHeader className="px-4 py-3 border-b border-border">
      <SheetTitle>{title}</SheetTitle>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
    <div className="flex-1 overflow-auto p-4">
      {children}
    </div>
  </SheetContent>
</Sheet>
```

### Dimensions

| Property | Value |
|----------|-------|
| Width | `w-[400px]` (400px default, 320px minimum) |
| Animation | Slide from right, 250ms `--duration-slide` |
| Overlay | Semi-transparent black (`--color-overlay`) |
| Breakpoint collapse | Full-screen on < 1024px (`w-full` or `sm:max-w-sm`) |

### Close Behavior

| Action | Behavior |
|--------|----------|
| Escape key | Closes (built into Sheet via Dialog primitive) |
| Click outside | Closes (built into Sheet via Dialog primitive) |
| X button | Closes (visible by default in SheetContent) |
| Programmatic | `onOpenChange={false}` |

### Content Categories

When opened from different triggers, the drawer shows:

| Trigger | Content |
|---------|---------|
| RCA result item | Full RCA analysis, confidence, evidence chain |
| History entry | Historical RCA record, timeline, actions taken |
| Alert item | Alert details, severity, service, timeline |

### Preserving Context

The drawer overlays the main content without navigating away. The main dashboard context remains visible behind the overlay. Focus is trapped within the drawer while open and returned to the trigger element on close.

---

## 5. Incident Timeline Pattern

### Structure

Horizontal timeline with severity-coded lanes:

```
 Timeline: [Alert] ──→ [RCA Started] ──→ [Evidence Found] ──→ [WeCom Created] ──→ [Manual Input] ──→ [RCA Complete] ──→ [Resolved]
             │              │                    │                    │                    │                  │              │
 Lane:    Critical    Investigating          Info             Investigating         Info           Investigating    Resolved
```

### Implementation

```tsx
// Container — scrolls horizontally
<div className="overflow-x-auto">
  <ol className="flex gap-0 min-w-max" role="list">
    {events.map((event, index) => (
      <li key={event.id} className="flex flex-col items-start relative min-w-[160px] max-w-[200px]">
        {/* Severity lane indicator */}
        <div className={cn(
          "h-1 w-full rounded-t-sm",
          event.severity === "critical" && "bg-status-active",
          event.severity === "warning" && "bg-status-investigating",
          event.severity === "info" && "bg-status-info",
        )} />

        {/* Event node */}
        <div className="flex items-start gap-3 p-3 w-full">
          {/* Icon */}
          <div className={cn(
            "mt-0.5 h-6 w-6 rounded-full flex items-center justify-center",
            event.severity === "critical" && "bg-status-active/10 text-status-active",
            event.severity === "warning" && "bg-status-investigating/10 text-status-investigating",
            event.severity === "info" && "bg-status-info/10 text-status-info",
          )}>
            {event.icon}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono tabular-nums text-muted-foreground">
              {event.timestamp}
            </p>
            <p className="text-sm text-foreground mt-0.5">{event.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {event.description}
            </p>
          </div>
        </div>

        {/* Connector to next event */}
        {index < events.length - 1 && (
          <div className="absolute top-3 -right-2 w-4 h-px bg-border" />
        )}
      </li>
    ))}
  </ol>
</div>
```

### Event Types

| Event | Icon | Severity | Description |
|-------|------|----------|-------------|
| Alert received | `Bell` | `critical` | Incoming alert matched a rule |
| RCA started | `Search` | `investigating` | Hermes agent session spawned |
| Evidence found | `FileText` | `info` | Specific metric/log/trace finding |
| WeCom group created | `MessageSquare` | `info` | Emergency collaboration group created |
| Manual finding | `UserPlus` | `info` | @bot submission from operator |
| RCA completed | `CheckCircle2` | `resolved` | Root cause determined |
| Incident resolved | `CheckCircle` | `resolved` | All actions completed |

### Scroll Behavior

- Container: `overflow-x-auto` with `min-w-max` on the inner list
- On smaller viewports, a subtle gradient fade indicates more content to the right
- The most recent event auto-scrolls into view on mount

---

## 6. Responsive Breakpoint Strategy

### Primary Target: Desktop 1440px+

```
Breakpoint: 1440px+ (primary)
┌──────────────────────────────────────────────────────────┐
│ Header 64px                                              │
├────────┬─────────────────────────────────────────────────┤
│        │  Three-panel view (40/35/25)                    │
│ Sidebar│  Full sidebar labels visible                    │
│ 240px  │                                                 │
│        │  Right drawer: 400px overlay                    │
└────────┴─────────────────────────────────────────────────┘
```

### Minimum: 1024px (Tablet Landscape)

```
Breakpoint: 1024px–1439px
┌─────────────────────────────────────────────────┐
│ Header 56px                                     │
├────────┬────────────────────────────────────────┤
│        │                                         │
│ Sidebar│  Three-panel collapses to tabs          │
│  56px  │  (with tooltips)                        │
│ (icon) │                                         │
│        │  Right drawer: full-width overlay       │
└────────┴─────────────────────────────────────────┘
```

### Collapse Behavior Below 1024px

| Element | Behavior |
|---------|----------|
| Sidebar | Collapses to 56px icon-only; labels hidden; tooltip on hover |
| Three-panel view | Collapses to stacked single-panel with tab switching |
| Right drawer | Full-width overlay (no side margin) |

### Breakpoint Constants

```tsx
// Tailwind v4 breakpoints (custom @theme in globals.css)
// These use Tailwind v4's default breakpoints:
// sm: 640px, md: 768px, lg: 1024px, xl: 1280px, 2xl: 1536px

// Custom ops-specific breakpoints:
const breakpoints = {
  desktop: 1440,  // Primary target width
  minSupported: 1024,  // Minimum supported width
  sidebarCollapse: 1024,  // Sidebar collapses below this
  panelCollapse: 1024,  // Three-panel collapses below this
}
```

### CSS Custom Properties

```css
/* Add to globals.css @theme */
--layout-header-height: 3.5rem;      /* 56px */
--layout-header-height-md: 4rem;     /* 64px */
--layout-sidebar-width: 15rem;       /* 240px */
--layout-sidebar-collapsed: 3.5rem;  /* 56px */
--layout-drawer-width: 25rem;        /* 400px */
--layout-drawer-width-min: 20rem;    /* 320px */
```

---

## 7. Queue/Position Display for RCA Concurrency

### Context

Per D-11, maximum concurrent RCA sessions defaults to 5 (configurable). When the limit is reached, new RCA requests enter a queue.

### Display Pattern

```
┌──────────────────────────────────────────────────────────┐
│ ⏳ 您的RCA已加入队列，当前位置: 2，当前活跃分析: 5个      │
│ (Your RCA is queued at position 2 of 5 active sessions.) │
│                                                          │
│ [Progess bar showing estimated wait]                     │
│ 预计等待时间: 约 3-5 分钟                                │
│ (Estimated wait: approximately 3-5 minutes)               │
└──────────────────────────────────────────────────────────┘
```

### Implementation

```tsx
// Queue position indicator
<div
  role="status"
  aria-live="polite"
  className="flex items-start gap-3 p-4 rounded-lg border border-border bg-surface-secondary"
>
  <Clock className="h-5 w-5 text-status-investigating mt-0.5 shrink-0" />
  <div className="space-y-1">
    <p className="text-sm text-foreground">
      您的RCA已加入队列，当前位置: <span className="font-semibold text-interactive-primary">{position}</span>，
      当前活跃分析: <span className="font-semibold">{activeSessions}</span>个
    </p>
    <div className="flex items-center gap-2">
      <Progress value={estimatedProgress} className="h-1 w-32" />
      <span className="text-xs text-muted-foreground">
        预计等待: {estimatedTime}
      </span>
    </div>
  </div>
</div>
```

### Real-Time Updates

- Queue position updates automatically as active sessions complete.
- Use polling (every 5-10 seconds) or WebSocket subscription via Hermes Gateway API.
- When position reaches 0, the RCA session starts automatically.
- Transition from "queued" to "in progress" shows agent investigation messages.

### States

| State | Visual |
|-------|--------|
| Queued | Amber clock icon + inline alert with position |
| Processing (next in queue) | Position shows "即将开始..." (Starting soon...) |
| Session started | Transition to agent investigation progress stream |

---

## 8. Header and Navigation Dimensions

### Reference Table

| Element | Width | Height | Notes |
|---------|-------|--------|-------|
| Header (mobile) | 100vw | 56px (`h-14`) | Fixed, z-index 30 |
| Header (desktop `md:`) | 100vw | 64px (`h-16`) | Fixed, z-index 30 |
| Sidebar (open) | 240px (`w-60`) | 100vh - header | Collapsible, z-index 20 |
| Sidebar (collapsed) | 56px (`w-14`) | 100vh - header | Icon-only mode |
| Main content | 1fr | 100vh - header | Scrolls independently |
| Right drawer | 400px (`max-w-[400px]`) | 100vh | Sheet component, z-index 50 |
| Right drawer (min) | 320px (`max-w-sm`) | 100vh | Minimum width |
| Panel header | 100% panel | 48px (`py-3 px-4`) | Sticky within panel |

### z-Index Stacking

| Layer | Element | z-index |
|-------|---------|---------|
| Base | Main content, sidebar | auto |
| Header | Fixed header bar | 30 |
| Drawer overlay | Sheet backdrop | 40 |
| Drawer | Sheet content | 50 |
| Dialog | Modal dialogs | 50 |
| Tooltip | shadcn/ui Tooltip | 60 |
| Toast | Sonner toasts | 100 |

---

## Related Files

| File | Description |
|------|-------------|
| `src/components/layout/dashboard-shell.tsx` | Dashboard shell component |
| `src/components/rca/rca-results-view.tsx` | Three-panel RCA results view |
| `src/components/rca/rule-wizard.tsx` | 4-step rule configuration wizard |
| `src/components/rca/incident-timeline.tsx` | Horizontal incident timeline |
