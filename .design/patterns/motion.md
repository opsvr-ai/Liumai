# Motion Guidelines — 六脉智能化运维数智平台

**Created:** 2026-07-17
**Design Task:** Task 04
**Related Files:** `src/styles/globals.css` (Section 5 — token definitions, Section 8 — reduced-motion)

---

## Table of Contents

1. [Core Principle: Functional-Only Animation](#1-core-principle-functional-only-animation)
2. [Token Reference](#2-token-reference)
3. [Animation Layer Hierarchy](#3-animation-layer-hierarchy)
4. [Agent Investigation Step Card States](#4-agent-investigation-step-card-states)
5. [Reduced-Motion Handling](#5-reduced-motion-handling)
6. [Usage Examples](#6-usage-examples)

---

## 1. Core Principle: Functional-Only Animation

**Animation must communicate a state change or spatial relationship. Never animate for decoration.**

This is non-negotiable. 六脉 is an operations platform used during production incidents. Operators need clarity, not visual flair. Every animation must answer one question: "What changed?"

### Allowed Animation Categories

| Category | Example | Justification |
|----------|---------|---------------|
| **Spatial relationship** | Panel slides in from right (drawer opens) | Tells operator where content came from |
| **Progress indication** | Progress bar fills during agent investigation | Communicates how much work remains |
| **Loading state** | Skeleton shimmer on placeholder content | Tells operator content is coming |
| **Completion state** | Checkmark appears with brief fade | Confirms action succeeded |
| **State transition** | Background color change on button hover | Signals interactivity |
| **Attention cue** | Alert badge subtle pulse for first 3s only | Draws attention to new critical event |

### Disallowed Animation Categories

| Category | Example | Why |
|----------|---------|-----|
| **Decorative entrance** | Logo flies in, text fades up on page load | No functional purpose, distracts during incidents |
| **Continuous pulse/glow** | Spinning loader that persists, pulsing border | Creates visual noise; operators stare at screens for hours |
| **Animated backgrounds** | Gradient animations, animated patterns | No informational value, wastes GPU cycles |
| **Logo/brand animation** | Animated logo, loading mascot | Irrelevant to incident resolution |
| **Decorative hover** | Card lift on hover, icon shake | Unnecessary in a tool where every interaction has a purpose |

### Single Exception

A **NEW alert arrival badge** may use a subtle pulse animation (opacity oscillation) for the first **3 seconds only**. After 3 seconds the badge is static. Implemented as:

```css
@keyframes alert-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.6; }
}

.alert-badge--new {
  animation: alert-pulse 1.5s ease-in-out 2;  /* runs twice = 3 seconds */
}
```

---

## 2. Token Reference

All motion tokens are defined in `src/styles/globals.css` Section 5 via the `@theme` directive. Use these tokens as Tailwind utility classes or as CSS custom properties.

### Duration Tokens

| Token | Value | Tailwind Utility | When to Use |
|-------|-------|-----------------|-------------|
| `--duration-instant` | `0ms` | `duration-instant` | Theme switches, reduced-motion override target |
| `--duration-fast` | `100ms` | `duration-fast` | Micro-interactions: hover, active, focus ring |
| `--duration-normal` | `200ms` | `duration-normal` | Standard transitions: panel open/close, element appear, state changes |
| `--duration-slow` | `300ms` | `duration-slow` | Entrance animations, modal overlay fade |
| `--duration-slide` | `250ms` | `duration-slide` | Slide-out drawer, sidebar collapse, Sheet open/close |

### Easing Curve Tokens

| Token | Value | Tailwind Utility | Behavior | When to Use |
|-------|-------|-----------------|----------|-------------|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | `ease-out` | Decelerate — fast start, slow end | Enter / reveal animations, panel slide-in |
| `--ease-in` | `cubic-bezier(0.4, 0, 0.68, 0.06)` | `ease-in` | Accelerate — slow start, fast end | Exit / dismiss animations |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | `ease-in-out` | Symmetric — slow start and end | Expand / collapse, size transitions |
| `--ease-linear` | `linear` | `ease-linear` | Constant speed | Color / opacity transitions only |

**Rule of thumb:** Enter animations use `ease-out` (snappy arrival). Exit animations use `ease-in` (quick disappearance). Size changes use `ease-in-out`. Opacity-only changes use `ease-linear`.

---

## 3. Animation Layer Hierarchy

Animations are organized into three layers by scope:

### Layer 1 — Component-Level (Micro-interactions)

Elements within a component that respond to user interaction. Shortest durations.

| Component | Trigger | Animation | Duration | Easing |
|-----------|---------|-----------|----------|--------|
| Button | `:hover` | Background color transition | `--duration-fast` | `--ease-linear` |
| Button | `:active` | Background + scale(0.97) | `--duration-fast` | `--ease-out` |
| Input | `:focus` | Border + ring color transition | `--duration-fast` | `--ease-linear` |
| Card | `:hover` | Border color change | `--duration-fast` | `--ease-linear` |
| Badge | state change | Background + icon reveal | `--duration-normal` | `--ease-out` |
| Tooltip | appear/disappear | Opacity transition | `--duration-fast` | `--ease-linear` |

### Layer 2 — Layout-Level (Spatial Transitions)

Panels, drawers, and structural elements that affect the page layout. Medium durations.

| Element | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Sidebar collapse/expand | Width transition + children fade | `--duration-slide` | `--ease-in-out` |
| Slide-out detail drawer | Translate X from right | `--duration-slide` | `--ease-out` |
| Panel collapse | Height/opacity transition | `--duration-normal` | `--ease-in-out` |
| Three-panel resizing | Width transition | `--duration-normal` | `--ease-in-out` |
| Modal/Sheet backdrop | Opacity fade | `--duration-slow` | `--ease-linear` |
| Progress bar fill | Width transition | `--duration-normal` | `--ease-out` |

### Layer 3 — Page-Level (View Transitions)

Content area transitions between views. Subtle and quick.

| Transition | Animation | Duration | Easing |
|------------|-----------|----------|--------|
| Content area view switch | Fade + subtle translateY(4px) | `--duration-normal` | `--ease-out` |
| Tab content change | Fade only (no translate) | `--duration-fast` | `--ease-linear` |
| Empty state appear | Opacity fade in | `--duration-normal` | `--ease-out` |

---

## 4. Agent Investigation Step Card States

Each step in the agent investigation progress stream is rendered as a card with exactly three states. These states map to M-05 (agent investigation progress in real-time) and the UX copy patterns from Task 06.

### Running State

A card with a determinate progress bar and a subtle left-to-right sweeping indicator. No spinner.

```css
/* Running state card */
.investigation-step--running {
  border-left: 3px solid var(--color-status-investigating);
}

/* Determinate progress bar (shadcn/ui Progress, 0-100%) */
.investigation-step__progress {
  transition: width var(--duration-normal) var(--ease-out);
}

/* Subtle sweep indicator — left-to-right pulse */
@keyframes sweep {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.investigation-step__sweep {
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--color-status-investigating) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: sweep 2s ease-in-out infinite;
}
```

Tailwind v4 usage (with shadcn/ui Progress):

```html
<div class="investigation-step--running rounded-lg border border-border-default bg-surface-secondary p-4">
  <div class="flex items-center gap-2 mb-2">
    <div class="investigation-step__sweep h-1 w-4 rounded-full"></div>
    <span class="text-sm text-text-secondary">正在分析指标数据...</span>
  </div>
  <div class="h-2 w-full rounded-full bg-surface-tertiary overflow-hidden">
    <div
      class="investigation-step__progress h-full rounded-full bg-status-investigating"
      style="width: 45%"
      role="progressbar"
      aria-valuenow="45"
      aria-valuemin="0"
      aria-valuemax="100"
    ></div>
  </div>
</div>
```

### Completed State

A card that transitions to a completed appearance with a checkmark reveal and brief background color change.

```css
.investigation-step--completed {
  border-left: 3px solid var(--color-status-resolved);
  transition:
    border-color var(--duration-normal) var(--ease-out),
    background-color var(--duration-normal) var(--ease-out);
}

/* Checkmark icon scales in */
@keyframes check-reveal {
  0%   { transform: scale(0); opacity: 0; }
  60%  { transform: scale(1.2); }
  100% { transform: scale(1); opacity: 1; }
}

.investigation-step__check {
  animation: check-reveal var(--duration-normal) var(--ease-out);
}
```

```html
<div class="investigation-step--completed rounded-lg border border-status-resolved/30 bg-surface-secondary p-4">
  <div class="flex items-center gap-2">
    <svg class="investigation-step__check h-4 w-4 text-status-resolved" aria-hidden="true">
      <!-- checkmark icon -->
    </svg>
    <span class="text-sm text-text-primary">分析完成: 发现 3 个异常</span>
  </div>
</div>
```

### Failed State

A card with a red left border, subtle red tint on background, and X icon.

```css
.investigation-step--failed {
  border-left: 3px solid var(--color-status-active);
  background-color: color-mix(
    in oklch,
    var(--color-surface-secondary),
    var(--color-status-active) 8%
  );
  transition:
    border-color var(--duration-normal) var(--ease-out),
    background-color var(--duration-normal) var(--ease-out);
}
```

```html
<div class="investigation-step--failed rounded-lg border border-status-active/20 p-4">
  <div class="flex items-center gap-2">
    <svg class="h-4 w-4 text-status-active" aria-hidden="true">
      <!-- X icon -->
    </svg>
    <span class="text-sm text-text-primary">分析失败: 数据源连接超时</span>
  </div>
</div>
```

---

## 5. Reduced-Motion Handling

### Global Override

The root CSS file contains this block (Section 8) which respects the user's OS-level motion preference:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

This overrides ALL durations to near-zero when the user has set their OS to reduce motion. `0.01ms` is used instead of `0s` because some browsers ignore `0s` animation-duration in certain contexts.

### Per-Element Control via Tailwind Variants

For cases where a specific animation should still work even in reduced-motion mode (e.g., opacity toggle for critical panel open/close), use Tailwind's `motion-safe:` and `motion-reduce:` variants:

```html
<!-- Animation only when user does NOT prefer reduced motion -->
<div class="motion-safe:transition-all motion-safe:duration-normal">
  <!-- animated content -->
</div>

<!-- Fallback: instant appearance when user prefers reduced motion -->
<div class="motion-reduce:opacity-100 motion-safe:opacity-0 motion-safe:transition-opacity motion-safe:duration-normal">
  <!-- content that fades in normally, appears instantly with reduced motion -->
</div>
```

### Critical Transitions Without Duration

For transitions that must work without animation (panel open/close, visibility toggles), use an **opacity toggle** pattern instead of relying on transition durations:

```css
/* Bad: relies on transition duration */
.panel {
  opacity: 0;
  transition: opacity var(--duration-normal) var(--ease-linear);
}
.panel--open {
  opacity: 1;
}

/* Good: works instantly even with reduced-motion override */
.panel {
  opacity: 0;
}
.panel--open {
  opacity: 1;
}
/* Animation layer is additive, not required for functionality */
.panel {
  transition: opacity var(--duration-normal) var(--ease-linear);
}
```

---

## 6. Usage Examples

### Example 1: Button Hover and Active States

```jsx
<button
  className={cn(
    "rounded-lg px-4 py-2 transition-colors duration-fast ease-linear",
    "bg-interactive-primary text-text-inverse",
    "hover:bg-interactive-hover",
    "active:scale-[0.97] active:transition-transform active:duration-fast active:ease-out"
  )}
>
  触发RCA
</button>
```

### Example 2: Slide-In Panel (Drawer)

```jsx
<div
  className={cn(
    "fixed right-0 top-0 h-full w-96 shadow-lg",
    "translate-x-full transition-transform duration-slide ease-out",
    open && "translate-x-0"
  )}
>
  {/* Panel content */}
</div>
```

### Example 3: Progress Bar Fill

```jsx
// shadcn/ui Progress component automatically uses transition
// Override with custom token:
<Progress
  value={progress}
  className="transition-[width] duration-normal ease-out"
/>
```

### Example 4: Skeleton Loading

```jsx
// shadcn/ui Skeleton component uses a shimmer animation
// Pulse animation is acceptable as a temporary loading state
<Skeleton className="h-4 w-full" />
```

### Example 5: New Alert Badge — Sole Animation Exception

```jsx
function AlertBadge({ isNew, label }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        "bg-status-active text-white",
        isNew && "animate-[alert-pulse_1.5s_ease-in-out_2]"
      )}
    >
      {label}
    </span>
  );
}
```

---

## Conventions Summary

| Rule | Applies To | Enforcement |
|------|-----------|-------------|
| Every animation must communicate a state change or spatial relationship | All code | Code review (Task 07) |
| Never animate for decoration | All code | Code review |
| Use token durations/easings only — no hardcoded values | CSS transitions & animations | Lint (custom rule TBD) |
| `--duration-slide` for drawer/sidebar transitions | Layout | Pattern enforcement |
| `--duration-fast` for micro-interactions | Component | Pattern enforcement |
| `--ease-linear` for color/opacity | All CSS | Guidelines |
| Agent step cards: determinate progress, no spinner | Agent progress UI | Pattern documentation |
| All animations gated by `motion-safe:` or global `@media` | All CSS | Section 8 in globals.css |
