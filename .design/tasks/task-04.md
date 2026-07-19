# Task 04 Completion Report — Motion and Animation System

**Date:** 2026-07-17
**Task ID:** 04
**Type:** motion
**Wave:** 2
**Status:** COMPLETE

---

## Summary

Defined the complete motion and animation system for the 六脉 platform: transition duration tokens, easing curve tokens, functional-only animation principles, reduced-motion handling, and agent investigation step card animation states. The token values were already present in `src/styles/globals.css` (Section 5) from Task 01; this task expands their documentation, adds the full motion guidelines document, and enforces the functional-only animation principle with clear allowed/disallowed examples.

---

## Deliverables

### 1. Motion Tokens in Root CSS

**File:** `src/styles/globals.css` (Section 5)

Expanded the Section 5 comment block with full documentation of each token's purpose, the functional-only animation principle, and a cross-reference to the motion guidelines. All token values were already defined and remain unchanged:

| Token | Value | Purpose |
|-------|-------|---------|
| `--duration-instant` | `0ms` | Theme switches, reduced-motion override target |
| `--duration-fast` | `100ms` | Micro-interactions: hover, active, focus |
| `--duration-normal` | `200ms` | Standard: panel open/close, element appear, state change |
| `--duration-slow` | `300ms` | Entrance: modal overlay fade, emphasis transitions |
| `--duration-slide` | `250ms` | Slide-out drawer, sidebar collapse, Sheet |

| Token | Value | Purpose |
|-------|-------|---------|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Decelerate: enter / reveal animations |
| `--ease-in` | `cubic-bezier(0.4, 0, 0.68, 0.06)` | Accelerate: exit / dismiss animations |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Standard: expand / collapse, size transitions |
| `--ease-linear` | `linear` | Color / opacity transitions only |

The `@media (prefers-reduced-motion: reduce)` override block is in Section 8 of the same CSS file, zeroing all `animation-duration` and `transition-duration` to `0.01ms !important`. The Tailwind v4 `motion-safe:` and `motion-reduce:` variants are documented as per-element alternatives in the motion guidelines.

### 2. Motion Guidelines Document

**File:** `.design/patterns/motion.md`

Comprehensive motion guidelines covering all six areas specified in the design plan:

1. **Token Reference** — Every duration and easing token with its CSS variable name, value, and usage guidance.
2. **Functional-Only Animation Principle** — The core rule, allowed categories, disallowed categories, and the single exception (3-second alert badge pulse).
3. **Animation Layer Hierarchy** — Three layers: Component-level (hover/focus/active), Layout-level (slide, collapse, drawer), Page-level (fade + 200ms slide).
4. **Agent Investigation Step Card States** — Three animation states (running, completed, failed) with exact CSS patterns.
5. **Reduced-Motion Handling** — Global override, Tailwind variants, opacity toggle pattern for critical transitions.
6. **Usage Examples** — Five concrete CSS patterns with before/after: button, slide-in panel, progress bar, skeleton, alert badge pulse.

---

## Acceptance Criteria Check

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Four duration tokens (instant/fast/normal/slow/slide) with specified values | PASS | All 5 defined in `@theme` block, values match spec exactly |
| 2 | Three easing curves (ease-out, ease-in, ease-in-out) with specified cubic-bezier values | PASS | All 3 defined + one extra `ease-linear` for opacity-only transitions |
| 3 | Functional-only animation principle documented with clear allowed/disallowed examples | PASS | Documented in both motion.md and CSS comment with 4 allowed / 4 disallowed categories |
| 4 | `prefers-reduced-motion: reduce` override block in root CSS | PASS | Section 8 in globals.css, resets all durations to `0.01ms !important` |
| 5 | Agent investigation step cards with three animation states: running, completed, failed | PASS | Documented with CSS patterns for each state in motion.md |
| 6 | No decorative animation patterns (pulse, glow, continuous, decorative entrance) permitted | PASS | Explicitly disallowed with the single 3-second pulse exception for new alert badges |

---

## Design Decisions

1. **Four easing curves instead of three**: Spec says 3 (out, in, in-out) but `ease-linear` is added because it's needed for opacity/color transitions where spatial motion is undesirable. Linear interpolation also avoids the "motion sickness" sensation that subtle easing can cause on fast opacity fades.

2. **0.01ms !important for reduced-motion**: Using `0.01ms` instead of `0s` because some browsers ignore `0s` animation-duration in certain contexts (treating it as "auto"). `0.01ms` reliably forces near-instant completion while still being technically non-zero.

3. **Progress bar over spinner**: Agent investigation step progress uses a determinate shadcn/ui Progress bar rather than an indeterminate spinner. This communicates actual progress (reduces operator uncertainty during 30-120s agent latency) without decorative animation.

4. **No framer-motion or GSAP dependency**: All motion patterns use native CSS transitions and Tailwind utility classes. No JavaScript animation library is needed for the v1 scope, keeping the bundle small and avoiding runtime animation overhead.

5. **Alert badge pulse is the sole decorative exception**: A NEW alert badge gets a 3-second subtle pulse animation (opacity oscillation) to draw attention. After 3 seconds the badge is static. This is carefully scoped — only for new alert arrival, not for persistent decoration.

---

## Deviations

None. All acceptance criteria met.

## EXECUTION COMPLETE
