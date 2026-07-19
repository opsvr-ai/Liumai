# Task 06 — UX Copy and Content Writing Guidelines

**Status:** COMPLETE
**Date:** 2026-07-17
**Executor:** design-executor agent

## Summary

Established the complete UX copy conventions for the 六脉 platform. Produced a comprehensive copy guidelines document at `.design/patterns/copy.md` covering voice/tone, button labels, error messages, loading states, empty states, agent progress streaming templates, and agent latency UX copy.

## Deliverables

| File | Description |
|------|-------------|
| `.design/patterns/copy.md` | Comprehensive copy guidelines document |

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| Voice and tone principles documented: professional, calm, concise, Chinese-primary with English technical terms | PASS |
| Button label convention: verb-first, max 4 characters primary / 6 characters secondary for Chinese labels | PASS |
| Error message three-part hierarchy (title + description + action) with Chinese examples | PASS |
| Loading state patterns for all agent investigation phases (preparing, metrics, logs, traces, report) | PASS |
| Empty state patterns for 3 scenarios: no RCA history, no matching alerts, no search results — each with action button | PASS |
| Agent investigation step copy templates for running/completed/failed states | PASS |
| Agent latency handling copy at 3 time thresholds (immediately, 30s, 2min) with optional notification feature | PASS |

## Key Content Decisions

- **Status color icon mapping**: Consistent with WCAG 1.4.1 from Task 05: resolved=CheckCircle (green), active=AlertCircle (red), investigating=Clock (amber), info=InfoCircle (blue). Icons referenced in status badge patterns.
- **Domain vocabulary aligned with DESIGN-CONTEXT.md**: All copy uses Hermes Agent, WeCom, RCA, 故障定界, 应急协同, and other platform-specific terms consistently.
- **Notification preference**: "分析完成后通知我" (Notify me when complete) option provided for long waits, respecting operators' need to multitask during 3-30 min agent investigations.
- **Progressive detail in error messages**: Three-part hierarchy ensures operators always know what happened, why, and what to do next — critical for high-pressure incident scenarios.
- **Agent step granularity**: Four investigation phases defined (metrics analysis, log querying, trace correlation, report generation) matching the expected Hermes RCA skill workflow, with percentage estimates for progress tracking.

## Deviations from Plan

None. All specifications from DESIGN-PLAN.md §Task 06 were followed exactly.

## Cross-References

- DESIGN-CONTEXT.md: D-07 (Minimal Operator UI), D-11 (Concurrency Limit), domain vocabulary for copy
- DESIGN-RESEARCH.md: Finding 4 (agent latency), Finding 6 (investigation progress streaming), Finding 8 (progress copy)
- Task 04: Motion patterns for investigation step card animations (running/completed/failed states)
- Task 05: WCAG 1.4.1 status indicator pattern (color + icon + label) — integrated into loading/status copy
- Task 03: Queue position display pattern (D-11 concurrency) — copy templates reference queue display
