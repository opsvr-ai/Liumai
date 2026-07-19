---
researched: 2026-07-17
project_type: B2B Operations Platform (AIOps Incident Management)
stack: React/TypeScript, Tailwind CSS v4, shadcn/ui, Hermes Agent, PostgreSQL
---

## Project Type Analysis

This is a **B2B operations platform for AIOps incident management** — a domain dominated by tools like PagerDuty, Datadog, and Grafana. Operators expect a dark-themed, data-dense interface optimized for rapid situational awareness during production incidents. The two core workflows — fault RCA and emergency collaboration — map to well-established incident management patterns (detect, triage, investigate, collaborate, resolve). Users are SREs and on-call engineers who spend extended sessions in the tool during incidents, so cognitive load reduction, at-a-glance status assessment, and minimal-click actions are critical. The unique differentiator is AI-powered multi-agent RCA orchestrated by Hermes Agent, which adds an agent-investigation visualization layer not present in traditional dashboards.

## Recommended Patterns

- **Incident Timeline with Severity Lanes**: A horizontal timeline view showing alert firing, RCA start/progress/completion, and collaboration events in parallel severity-coded lanes. Matches the user expectation from PagerDuty and OpsGenie. Source: Web search — incident management UI conventions.

- **Service Topology Graph for RCA Blast Radius**: A directed graph showing service dependencies with color-coded edge weights (error rate) and node severity highlighting the root cause path. Operators understand fault propagation visually. Source: PyRCA causal graph pattern, OpenSearch MCP trace analysis.

- **Three-Panel RCA Results View**: Left panel (causal graph / evidence chain), center panel (AI-generated natural language summary with timeline), right panel (feature importance — which metrics/logs contributed most to the root cause). This matches the multi-view explanation dashboard pattern rated highly by operators in power plant anomaly detection studies. Source: Web search — HSU Hamburg/LEAG multi-view dashboard study.

- **Progressive Disclosure Wizard for Alert Rules**: Step-by-step rule configuration: (1) trigger/event specification, (2) condition specification with cascading provider-instance-metric menus, (3) action specification (RCA skill invocation + WeCom group creation), (4) review. Step indicator with completion progress. Source: Grafana Alerting redesign, patents US20210152414A1.

- **Dark Gray Canvas with Semantic Accent Colors**: Use deep charcoal backgrounds (#1a1b1e range), not pure black. Reserve color exclusively for semantic status: green for resolved, red for active/firing, yellow/amber for investigating. No decorative color. This matches the One Dark-inspired operator dashboard convention. Source: Web search — operator console design research.

- **Monospace-Heavy Data Typography**: Use a monospace font (JetBrains Mono or IBM Plex Mono) for metric values, timestamps, trace IDs, and structured data labels. Tabular numbers enabled via `font-variant-numeric: tabular-nums`. Uppercase small headers (10-11px) for section labels. Large value displays (26-32px) for key incident metrics. Source: Web search — dark theme DevOps dashboard design patterns.

- **Slide-Out Detail Drawers for Drill-Down**: Instead of navigating away from the main dashboard, use slide-out panels for RCA detail, rule configuration detail, and collaboration history. Preserves spatial context during incident investigation. Source: Grafana Alerting operations workspace pattern.

- **Agent Investigation Progress Stream**: A chat-like streaming log showing the Hermes agent's investigation steps in real-time (examining logs, checking metrics, analyzing traces), simultaneously pushed to the UI and the WeCom group. Each step shown as a collapsible card with status indicator (running/completed/failed). Source: Derived from M-05 requirement and Hermes Agent session streaming capabilities.

- **@Bot Manual Input Capture in Timeline**: Manual findings submitted via WeCom @mention rendered as annotated entries in the collaboration timeline, visually distinguished from agent-generated entries (e.g., different icon, left-aligned human vs. right-aligned agent). Source: Derived from M-06 requirement.

- **Collapsible Panel Layout with Drag Handles**: Dashboard organized into resizable panels (alert list, active incidents, timeline, service map) that operators can customize and resize. Sticky headers for each panel. Full-viewport grid layout (100vh), no unnecessary scrolling. Source: Web search — Grafana and operator dashboard layout conventions.

## Pitfalls to Avoid

- **Pure Black Background (#000)**: Operators stare at these screens for hours during incidents. Pure black causes eye strain with light text (halation effect). Use dark gray (#1a1b1e or similar) instead. Source: Web search — dark theme UX research.

- **Color-Only Status Indicators**: Never convey incident status (active/resolved/investigating) solely through color. Always include a text label, icon, or shape differentiation for accessibility (WCAG SC 1.4.1). Source: WCAG 2.1.

- **Decorative Animations During Incidents**: Pulse effects, glowing borders, or animated logos create noise during high-stress situations. Reserve animation exclusively for state changes (new alert arrival, investigation step completion) and use subtle, functional transitions only. Source: Web search — operator console design principles.

- **Modal Overload for Rule Configuration**: Avoid a single monolithic modal for rule creation. Operators configure many rules — a modal that covers the context is frustrating. Use a wizard with a progress indicator or a dedicated configuration page with persistent context. Source: Grafana Alerting UX research.

- **Agent Output Without Human Verification Cues**: AI-generated RCA results presented as definitive fact risk operators trusting incorrect conclusions. Always show confidence indicators, evidence citations, and provide a feedback mechanism (confirm/object). Source: Web search — AI-in-operations UX best practices.

- **Generic Loading States for Agent Investigation**: A simple spinner while the agent investigates (which may take 30-120 seconds) is insufficient. Show progressive updates: "Checking metric X...", "Analyzing logs (45% complete)...", "Correlating traces...". This manages operator expectations and builds trust in the agent's process. Source: Derived from M-05 and agent UX research.

## Stack-Specific Notes

- **Tailwind CSS v4 + shadcn/ui**: Token customization happens via `@theme` directive in CSS, not `tailwind.config.ts` (v4 removes the JS config file). Use `@theme inline` for single-theme dark mode. The shadcn/ui CSS variable approach (`--background`, `--foreground`, `--primary`, etc.) coexists with Tailwind's `@theme` — define semantic tokens in `@theme` and reference shadcn CSS variables for component compatibility.

- **shadcn/ui Component Customization**: Components are copied to `src/components/ui/` via `npx shadcn add`. Customize by editing the copied source, not by extending base classes. Use the `cn()` utility (`tailwind-merge` + `clsx`) for conditional class merging. Define custom variants using the shadcn/ui `cva` pattern (class-variance-authority).

- **React + TypeScript**: RSC (React Server Components) considerations if using Next.js App Router. Data-fetching for the dashboard (alert lists, incident history) should use server components where possible. Client components should be isolated to interactive areas (rule configuration forms, real-time timeline streaming, panel drag handles).

- **Hermes Agent Skills**: RCA logic lives in `SKILL.md` files, not in the platform backend. The frontend communicates with the agent via Hermes Gateway API. Design the UI to poll or subscribe to agent session state, not to execute agent logic directly.

- **WeCom Integration**: The Hermes WeCom adapter uses WebSocket transport (not HTTP webhooks). Real-time UI updates for collaboration events can piggyback on the same WebSocket connection or use a separate subscription via the Hermes Gateway API. The adapter supports markdown rendering, media attachments, and reply-mode streaming — all usable from the platform.

- **PostgreSQL Backend**: Stores rule configurations, audit trails, and RCA session records. The Hermes session store (SQLite) handles agent-level history; the platform DB (PostgreSQL) handles business-level audit trails. Do not conflate the two storage concerns in the design.
