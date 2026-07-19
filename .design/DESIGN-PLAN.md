---
project: 六脉 (Liumai) — 智能化运维数智平台
created: 2026-07-17T00:00:00.000Z
waves: 2
context: .design/DESIGN-CONTEXT.md
parallel_ready: false
---

## Wave 1

### Task 01 — Design Token System
Type: tokens
Scope: Establish the complete design token layer for 六脉. Define color palette (dark theme surfaces, semantic status colors, text hierarchy), typography scale (sans-serif + monospace for data surfaces), spacing scale, border radius, and motion tokens. All tokens expressed as Tailwind v4 `@theme` custom properties in the root CSS file, coexisting with shadcn/ui CSS custom properties (`--background`, `--foreground`, `--primary`, etc.). No implementation code outside CSS token definitions.
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md (decisions: D-07)
  - .design/DESIGN-PATTERNS.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Create the root CSS token file at `src/styles/globals.css` (or the equivalent Tailwind v4 entry point). Define tokens using the `@theme` directive per Tailwind v4 convention. The token system must cover four domains:

  1. **Color tokens:**
     - Surface colors: use dark gray canvas (#1a1b1e range), not pure black. Define `--color-surface-primary`, `--color-surface-secondary`, `--color-surface-tertiary` with decreasing luminance.
     - Text hierarchy: `--color-text-primary` (high-emphasis, near-white), `--color-text-secondary` (medium-emphasis, light gray), `--color-text-muted` (low-emphasis, dim gray), `--color-text-inverse` (for dark-on-light scenarios).
     - Interactive: `--color-interactive-primary` (brand color for primary actions), `--color-interactive-hover`, `--color-interactive-active`.
     - Semantic status: `--color-status-resolved` (green, ~#22c55e), `--color-status-active` (red, ~#ef4444), `--color-status-investigating` (amber, ~#f59e0b), `--color-status-info` (blue, ~#3b82f6). These must be usable as text color, background fill, and border.
     - Border and divider: `--color-border-default`, `--color-border-subtle`.
     - Overlay: `--color-overlay` for modal backdrops (semi-transparent black).

  2. **Typography tokens:**
     - Font family: define `--font-sans` (system sans-serif stack: `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"`) and `--font-mono` (monospace stack: `"JetBrains Mono", "IBM Plex Mono", "SF Mono", ui-monospace, monospace`).
     - Font size scale: Tailwind v4 default scale (xs 0.75rem, sm 0.875rem, base 1rem, lg 1.125rem, xl 1.25rem, 2xl 1.5rem, 3xl 1.875rem, 4xl 2.25rem). Add `--font-size-data` (0.8125rem) for dense data displays.
     - Font weights: normal 400, medium 500, semibold 600, bold 700.
     - Line heights: tight (1.15) for headings, normal (1.5) for body, data-dense (1.3) for tables and metrics.
     - Enable `font-variant-numeric: tabular-nums` on monospace text for aligned number display.

  3. **Spacing and radius tokens:**
     - Use Tailwind v4 default rem-based spacing scale (0.25rem steps).
     - Border radius: `--radius-sm` 0.25rem, `--radius-md` 0.375rem, `--radius-lg` 0.5rem, `--radius-xl` 0.75rem, `--radius-2xl` 1rem. shadcn/ui default is 0.5rem for `--radius` -- preserve this.
     - Override shadcn/ui CSS variables (`--radius`) to match.

  4. **Shadow and elevation tokens:**
     - `--shadow-sm`, `--shadow-md`, `--shadow-lg` using dark-theme-appropriate shadow colors (black with varying opacity).

  In the same file, override shadcn/ui CSS custom properties (`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`) to align with the dark theme palette defined above. This ensures shadcn/ui components consume the same color system. Document the mapping between 六脉 semantic tokens and shadcn CSS variables in a comment block.

  **End state:** A single CSS token file that both Tailwind v4 utilities and shadcn/ui components can reference. No hardcoded color, size, or motion values anywhere in the codebase outside this file.

Acceptance criteria:
  - All surface backgrounds use dark gray values in the #1a1b1e range; no #000000 pure black appears as a surface color.
  - Semantic status tokens (resolved/active/investigating/info) are defined and use distinct hues (green/red/amber/blue).
  - Monospace font stack (`--font-mono`) is defined and targeted at data surfaces (metrics, timestamps, trace IDs, log output).
  - shadcn/ui CSS variables (`--background`, `--foreground`, `--primary`, etc.) are overridden and consistent with the 六脉 dark palette.
  - All tokens are defined via `@theme` in the root CSS file; no `tailwind.config.js` or JS-based token overrides exist.

---

### Task 02 — shadcn/ui Component Foundation
Type: component
Scope: Initialize shadcn/ui in the project, add core shared UI components, customize their dark-theme styling to match the 六脉 token system from Task 01. Establish component authoring conventions (cn() utility, cva variant patterns, file organization). Do not build full page layouts or feature components.
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md (decisions: D-07)
  - .design/DESIGN-PATTERNS.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Execute the following steps:

  1. **Initialize shadcn/ui:** Run `npx shadcn@latest init` with the following options:
     - Style: New York (shadcn/ui default style)
     - Base color: Slate (neutral base that works with dark theme)
     - CSS variables: Yes
     - React Server Components: No (classic React/SPA unless using Next.js App Router)
     - Tailwind CSS: v4
     - Import alias: `@/` or as appropriate for the project structure
     - CSS path: `src/styles/globals.css` (the file from Task 01)

  2. **Add core shared components** via `npx shadcn@latest add [component]`:
     - `button`, `card`, `dialog`, `input`, `select`, `badge`, `tabs`, `alert`, `sheet` (for slide-out drawers), `separator`, `tooltip`, `dropdown-menu`, `scroll-area`, `progress`, `skeleton`, `toast`, `sonner` (for notifications).
     - Add `table` for data-heavy RCA history views.

  3. **Customize component tokens:** In the root CSS file (from Task 01), verify the shadcn/ui CSS variables are consuming 六脉 token values:
     - `--primary` maps to the brand interactive color
     - `--destructive` maps to `--color-status-active` (red)
     - `--muted` and `--muted-foreground` use secondary surface and muted text
     - `--border` and `--input` use `--color-border-default`
     - `--ring` uses the interactive color at partial opacity for focus rings

  4. **Establish file organization convention:** Create a convention document or inline comment pattern:
     - shadcn/ui components live in `src/components/ui/`
     - Custom application components live in `src/components/` or `src/components/[feature]/`
     - All imports use the `@/` alias
     - Conditional classes use the `cn()` utility (from `tailwind-merge` + `clsx`)
     - Custom variants use `cva` from `class-variance-authority`

  5. **Add custom `Badge` variants:** Extend the shadcn/ui Badge component with semantic status variants:
     - `badge--resolved` (green/status-resolved)
     - `badge--active` (red/status-active)
     - `badge--investigating` (amber/status-investigating)
     - `badge--info` (blue/status-info)
     Use the `cva` pattern consistent with the existing Badge variants.

  6. **Add custom `Button` variants:** Add a `ghost--muted` variant for secondary toolbar actions (low-visibility buttons common in ops toolbars).

  **End state:** shadcn/ui is initialized with dark theme applied correctly. Core components are available and styled according to 六脉 tokens. Custom variant patterns are established.

Acceptance criteria:
  - `npx shadcn@latest init` completes successfully with dark theme as default.
  - All listed shadcn/ui components (button, card, dialog, input, select, badge, tabs, alert, sheet, separator, tooltip, dropdown-menu, scroll-area, progress, skeleton, toast/sonner, table) are added to `src/components/ui/`.
  - Badge component has four custom semantic variants (resolved, active, investigating, info) using the corresponding status tokens.
  - Dark theme CSS variables in root CSS file are verified to produce visible components (no invisible buttons, no unreadable text on dark backgrounds).
  - File organization convention is documented: shadcn components in `src/components/ui/`, custom components in `src/components/[feature]/`, cn() utility for class merging.

---

## Wave 2

### Task 03 — Layout Framework and Navigation Patterns
Type: layout
Scope: Define the dashboard layout skeleton, panel system, and navigation architecture for the 六脉 platform. Establish the grid structure, responsive breakpoint strategy, collapsible panel conventions, slide-out detail drawer pattern, and the three-panel RCA results view layout. Document layout patterns for the two main views: RCA Dashboard and RCA History. This task produces layout specifications and pattern documentation, not full page implementations.
Depends on: Task 01
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md (decisions: D-07, D-10, D-11)
  - .design/DESIGN-PATTERNS.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Create layout pattern documentation at `.design/patterns/layout.md` that specifies the following patterns. Each pattern must reference specific Tailwind v4 classes or CSS custom properties where applicable.

  1. **Dashboard shell layout:**
     - Full-viewport height (`h-dvh` or `h-screen`).
     - Fixed top header bar (56-64px) with: project logo, current incident indicator, user menu (role-aware per D-10 RBAC).
     - Left sidebar (240px collapsible to 56px icon-only) for primary navigation: Dashboard, RCA History, Rule Configuration, Settings. Use shadcn/ui Sheet or custom collapsible sidebar.
     - Main content area fills remaining space, scrolls independently.
     - Optional right panel (320-400px) for context detail (slide-out drawer).

  2. **Three-panel RCA results view (from DESIGN-RESEARCH.md finding 7):**
     - Left panel (40%): causal graph visualization area with node-edge rendering. Show affected services with color-coded severity states.
     - Center panel (35%): AI-generated natural language summary of the root cause with confidence indicator. Below summary: evidence chain timeline showing each agent investigation step.
     - Right panel (25%): evidence detail panel — key metrics, log excerpts, trace IDs that contributed to the root cause determination.
     - All panels collapsible with sticky headers. Panels should have optional drag handles for resizing.

  3. **Progressive disclosure wizard pattern (from DESIGN-RESEARCH.md finding 4):**
     - Step indicator with numbered stages and completion checkmarks.
     - Four steps: (1) Trigger/Event Specification, (2) Condition Configuration (cascading provider-instance-metric menus), (3) Action Specification (select RCA skill + WeCom group config), (4) Review and Confirm.
     - Navigation: Back/Next buttons, step indicator clickable for review.
     - Used for alert-to-RCA rule configuration (M-01).

  4. **Slide-out detail drawer pattern (from DESIGN-RESEARCH.md finding 7):**
     - Use shadcn/ui Sheet component anchored to the right edge.
     - Opens from any list item click (RCA result, history entry, alert item).
     - Preserves main dashboard context (does not navigate away).
     - Contains drill-down detail: full RCA analysis, collaboration timeline, raw evidence.
     - Close via Escape key, click-outside, or X button.

  5. **Incident timeline pattern (from DESIGN-RESEARCH.md finding 1):**
     - Horizontal timeline with severity-coded lanes (critical, warning, info).
     - Events: alert received, RCA started, evidence found, WeCom group created, manual findings submitted, RCA completed, incident resolved.
     - Each event shows: timestamp, event type icon, brief description, related agent step.
     - Timeline scrolls horizontally within its container.

  6. **Responsive breakpoint strategy:**
     - Primary target: desktop 1440px+ (ops platforms are desktop-first).
     - Minimum supported width: 1024px (tablet landscape).
     - Below 1024px: sidebar collapses to icon-only, three-panel view collapses to single-panel with tab switching.
     - Document breakpoint constants using Tailwind v4 `@screen` or CSS custom properties.

  7. **Queue/position display for RCA concurrency (D-11):**
     - When max concurrent sessions (default 5) is reached, new RCA requests show a queue position.
     - Display as badge or inline alert: "Your RCA is queued at position 2 of 5 active sessions."
     - Queue position updates in real-time as sessions complete.

  **End state:** A comprehensive layout pattern document that any implementation can follow. No full page code is written — only layout specifications, grid definitions, and component arrangement patterns.

Acceptance criteria:
  - Dashboard shell layout specifies header (56-64px), collapsible sidebar (240px/56px), main content area, and optional right drawer with exact dimensions.
  - Three-panel RCA view specifies width ratios (40/35/25%), collapsible behavior, and sticky headers for each panel.
  - Progressive disclosure wizard has exactly 4 documented steps with navigation rules (Back/Next, step indicator clickable for review).
  - Slide-out detail drawer is anchored right, uses shadcn/ui Sheet, preserves main context, closes on Escape/click-outside/X.
  - Breakpoint strategy documented: primary at 1440px+, minimum at 1024px with defined collapse behavior.
  - Queue position display pattern documented for RCA concurrency exceeding D-11 default of 5.

---

### Task 04 — Motion and Animation System
Type: motion
Scope: Define transition durations, easing curves, animation tokens, and motion conventions for the 六脉 platform. Enforce the functional-only animation principle from DESIGN-RESEARCH.md. Document reduced-motion handling. No animation implementation beyond token definitions and usage guidelines.
Depends on: Task 01
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Add motion tokens to the root CSS file (from Task 01) and create motion usage guidelines at `.design/patterns/motion.md`. Follow these specifications:

  1. **Transition duration tokens (add to `@theme` in root CSS):**
     - `--duration-instant`: 0ms (no animation — for theme switches, reduced-motion mode)
     - `--duration-fast`: 100ms (micro-interactions: hover, active states)
     - `--duration-normal`: 200ms (standard transitions: panel open/close, element appear)
     - `--duration-slow`: 300ms (entrance animations, modal overlay fade)
     - `--duration-slide`: 250ms (slide-out drawer, sidebar collapse)

  2. **Easing curve tokens:**
     - `--ease-out`: cubic-bezier(0.16, 1, 0.3, 1) — decelerate, for enter animations
     - `--ease-in`: cubic-bezier(0.4, 0, 0.68, 0.06) — accelerate, for exit animations
     - `--ease-in-out`: cubic-bezier(0.65, 0, 0.35, 1) — standard, for expand/collapse
     - `--ease-linear`: linear — for color/opacity transitions only

  3. **Functional-only animation principle:**
     - Document the rule: Animation must communicate a state change or spatial relationship. Never animate for decoration (no pulsing logos, glowing borders, spinning loaders that persist).
     - Allowed: panel slide-in (spatial relationship), progress fill (state change), skeleton shimmer (loading state), checkmark reveal (completion state).
     - Disallowed: decorative entrance animations, continuous pulse/glow effects, animated background patterns, logo animations.
     - Exception: status badge subtle pulse on NEW alert arrival (only first 3 seconds, then static).

  4. **Agent investigation progress animation pattern (from DESIGN-RESEARCH.md finding 6):**
     - Each investigation step shown as a card with three states: running (subtle left-to-right progress indicator), completed (checkmark + brief fade to completed color), failed (X icon + red tint).
     - Step transition uses `--duration-normal` with `--ease-out`.
     - Progress indicator uses a determinate progress bar (shadcn/ui Progress) not an indeterminate spinner.

  5. **Reduced-motion handling:**
     - Wrap all custom animations in `@media (prefers-reduced-motion: reduce)`:
       ```css
       @media (prefers-reduced-motion: reduce) {
         *, *::before, *::after {
           animation-duration: 0.01ms !important;
           transition-duration: 0.01ms !important;
         }
       }
       ```
     - Document that this overrides ALL durations to near-zero on user preference.
     - For critical transitions that must still work (like panel open/close), use `opacity` toggle (0 to 1) without animation rather than relying on transition durations.
     - Document the `motion-safe` and `motion-reduce` Tailwind v4 variants as alternative for per-element control.

  6. **Animation layer in design hierarchy:**
     - Component-level: transitions on hover/focus/active (button, input, card hover)
     - Layout-level: panel slide-in/out, sidebar collapse, drawer open/close
     - Page-level: content area transitions between views (fade + subtle slide, 200ms)

  **End state:** Motion tokens are defined in the root CSS. A motion guidelines document exists at `.design/patterns/motion.md` covering all patterns above. No decorative animation anywhere in the design spec.

Acceptance criteria:
  - Four duration tokens (instant/fast/normal/slow/slide) defined as CSS custom properties with the specified values.
  - Three easing curves defined (ease-out, ease-in, ease-in-out) with the specified cubic-bezier values.
  - Functional-only animation principle documented with clear allowed/disallowed examples.
  - `prefers-reduced-motion: reduce` override block included in root CSS to zero all animation/transition durations.
  - Agent investigation step cards have three animation states defined: running, completed, failed.
  - No decorative animation patterns (pulse, glow, continuous, decorative entrance) are permitted in the guidelines.

---

### Task 05 — Accessibility Foundation
Type: accessibility
Scope: Establish accessibility constraints and patterns for the 六脉 dark theme UI. Define focus ring styles, contrast compliance thresholds, status indicator patterns (color + icon + label per WCAG 1.4.1), ARIA landmark roles for dashboard layout, keyboard navigation patterns, and semantic markup conventions. This task produces accessibility pattern documentation and CSS focus styles.
Depends on: Task 01, Task 02
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md
  - .design/DESIGN-PATTERNS.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Create accessibility pattern documentation at `.design/patterns/accessibility.md` and add focus styles to the root CSS file. Follow these specifications:

  1. **Focus ring styles (add to root CSS):**
     - Global `:focus-visible` outline style:
       ```css
       :focus-visible {
         outline: 2px solid var(--color-interactive-primary);
         outline-offset: 2px;
       }
       ```
     - Ensure the focus ring color has sufficient contrast against all surface backgrounds it may appear on (minimum 3:1 for large UI components, 4.5:1 for text).
     - For shadcn/ui components that use `--ring`, verify `--ring` is set to the interactive primary color at 0.8 opacity for a softer focus indicator that still meets contrast requirements.
     - For custom components (data tables, graph areas, time selectors), define `focus-visible` ring styles that match the shadcn/ui convention.

  2. **Status indicator pattern (WCAG 1.4.1 compliance):**
     - Document the rule: Incident status MUST NOT be conveyed by color alone. Every status indicator must include at minimum TWO of: color, icon, text label.
     - Pattern specification:
       - Status badge: colored background + status text label + icon (CheckCircle for resolved, AlertCircle for active, Clock for investigating, Info for info).
       - Status dot (compact display): colored dot + tooltip or aria-label with status text.
       - Status row in table: colored sidebar (2px left border) + status badge in cell.
     - Map the three incident states to specific Lucide icon names: resolved=CheckCircle, active=AlertCircle, investigating=Clock, info=Info.

  3. **Contrast compliance thresholds:**
     - Document minimum contrast ratios for the dark theme:
       - Normal text (<18px / <14pt bold): minimum 4.5:1 against background.
       - Large text (>=18px / >=14pt bold): minimum 3:1 against background.
       - UI components and graphical objects (focus indicators, status dots): minimum 3:1 adjacent color difference.
       - Placeholder text: no minimum, but should be distinguishable from input text (recommend 3:1 against background).
     - Reference the specific color token contrasts:
       - `--color-text-primary` on `--color-surface-primary`: verify >= 7:1 (enhanced).
       - `--color-text-secondary` on `--color-surface-primary`: verify >= 4.5:1.
       - `--color-text-muted` on `--color-surface-primary`: verify >= 3:1.
       - Status green (`--color-status-resolved`) on `--color-surface-primary`: verify >= 3:1 for UI components.

  4. **ARIA landmark roles for dashboard layout:**
     - Document the ARIA roles for the dashboard shell (from Task 03):
       - Header: `<header role="banner">` or `<header>`
       - Sidebar: `<nav role="navigation" aria-label="Main navigation">`
       - Main content: `<main role="main">`
       - Right detail panel: `<aside role="complementary" aria-label="Detail panel">`
       - Status/toast region: `<div role="status" aria-live="polite">`
       - Alert region (critical errors): `<div role="alert">`
     - For the three-panel RCA view (from Task 03):
       - Each panel: `<section aria-labelledby="[panel-heading-id]">`
       - Panel headings: `<h2 id="...">` or `<h3>` depending on hierarchy
       - Causal graph container: `<figure role="img" aria-label="Service dependency graph showing root cause path">`
       - Timeline: `<ol role="list">` with `<li>` for each event

  5. **Keyboard navigation patterns:**
     - Document Tab order: header controls -> sidebar nav -> main content -> optional detail panel.
     - All interactive elements must be reachable via Tab.
     - Sidebar navigation uses `aria-current="page"` on active item.
     - Slide-out drawer (Sheet) traps focus while open; returns focus to trigger on close.
     - Data tables use standard table keyboard navigation (Tab into table, then arrow keys within, Tab to exit).

  6. **Semantic markup conventions:**
     - Use semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<article>`, `<figure>`, `<table>`, `<button>`, `<a>`) rather than `<div>` with ARIA role overrides where possible.
     - Exception: custom interactive components (select, combobox, dialog) use shadcn/ui's Radix primitives which handle ARIA correctly out of the box.
     - All icons must have `aria-hidden="true"` when accompanied by visible text labels, or `aria-label` when used standalone.

  **End state:** Accessibility pattern documentation exists. Focus styles are defined in the root CSS. Status indicator pattern is specified with exact icons and markup patterns. ARIA landmark roles are mapped to the dashboard layout.

Acceptance criteria:
  - `:focus-visible` styles defined globally with 2px solid outline using `--color-interactive-primary` and 2px offset.
  - Status indicator pattern documented: status conveyed via color + icon + text label (minimum 2 of 3 channels per WCAG 1.4.1).
  - Minimum contrast ratios documented for normal text (4.5:1), large text (3:1), and UI components (3:1) against dark surfaces.
  - ARIA landmark roles mapped to all 5 dashboard shell regions (header, nav, main, complementary, status/alert).
  - Keyboard navigation Tab order documented: header -> sidebar -> main -> detail panel.
  - Semantic HTML preference documented with Radix primitive exception for custom interactive components.

---

### Task 06 — UX Copy and Content Writing Guidelines
Type: copy
Scope: Establish conventions for all user-facing text in the 六脉 platform: button labels, error messages, empty states, loading states, the agent progress streaming language, and form field labels. These patterns ensure consistent tone and clarity across the operator interface. This task produces a copy guidelines document with specific examples for every content type.
Depends on: Task 01
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Create copy guidelines at `.design/patterns/copy.md` covering the following sections with specific, templated examples:

  1. **Voice and tone principles:**
     - Professional, calm, concise. No alarmist language even during active incidents.
     - Use Chinese (Simplified) as primary UI language (operators are Chinese-speaking SREs).
     - Technical terms in English where standard (RCA, SLA, metrics, traces, root cause).
     - Avoid jargon that operators wouldn't use; match the domain vocabulary from DESIGN-CONTEXT.md.

  2. **Button label conventions:**
     - Verb-first, active voice: "触发RCA" (Trigger RCA), "创建规则" (Create Rule), "查看详情" (View Details), "确认结果" (Confirm Result), "忽略" (Dismiss), "重新分析" (Re-analyze).
     - Maximum 4 Chinese characters for primary action buttons, 6 for secondary.
     - Destructive actions: "删除规则" (Delete Rule) — red button with alert icon, confirmation dialog.
     - Disabled state: tooltip explaining why ("已达到最大并发限制" — Max concurrency reached).

  3. **Error message hierarchy:**
     - Every error message must have three parts when space permits:
       - Title (short, direct): "连接失败" (Connection Failed)
       - Description (what happened, why): "无法连接到 Hermes Agent，请检查网关状态" (Cannot connect to Hermes Agent, check gateway status)
       - Action (what user can do): "重试" (Retry) or "查看网关配置" (View Gateway Config)
     - Toast errors (shadcn/ui Sonner): title + description only, auto-dismiss after 8 seconds for non-critical, manual dismiss for critical.
     - Inline errors (form validation): red text below field, specific to the field: "告警级别为必填项" (Alert severity is required).

  4. **Loading and waiting states (critical for 3-30 min agent latency per research finding 4):**
     - NEVER use generic "加载中..." (Loading...). Always be specific about what is happening.
     - Agent investigation steps use progressive messages:
       - "正在分析指标数据 (25%)..." (Analyzing metrics 25%)
       - "正在查询日志 (45%)..." (Querying logs 45%)
       - "正在关联追踪数据 (70%)..." (Correlating trace data 70%)
       - "正在生成根因分析报告 (90%)..." (Generating RCA report 90%)
     - Session queue message: "您的RCA已加入队列，当前位置: {N}，当前活跃分析: {M}个" (Your RCA is queued position N of M active sessions).
     - Long wait (>60s) guidance: "分析预计需要 2-5 分钟，您可以最小化此面板并在分析完成后收到通知" (Analysis estimated 2-5 min, you can minimize this panel and receive notification when complete).

  5. **Empty state patterns:**
     - No RCA history yet: "暂无RCA记录。当告警触发或手动发起RCA后，分析记录将显示在此处" (No RCA records yet. Records will appear here when alerts trigger or RCA is manually initiated.)
     - No alerts matching rule: "当前没有匹配规则的告警。您可以在规则配置中调整触发条件" (No alerts matching current rules. Adjust trigger conditions in rule configuration.)
     - No search results: "未找到与"{query}"匹配的结果。请尝试不同的搜索词" (No results matching "{query}". Try different search terms.)
     - Each empty state includes a relevant action button (e.g., "配置规则" — Configure Rule).

  6. **Agent progress streaming copy (from M-05 and research finding 8):**
     - Each investigation step formatted as a card/entry:
       - Running: "正在分析: {data-source}" with progress indicator
       - Completed: "[完成] {data-source} — 发现 {N} 个异常" (Completed: found N anomalies in {data-source})
       - Failed: "[失败] {data-source} — 连接超时" (Failed: {data-source} — connection timeout)
     - Evidence discovery: "发现异常指标: {metric-name} 在 {time} 时偏离基线 {X}%" (Anomalous metric found: {metric-name} deviated from baseline by X% at {time})
     - Root cause summary final message: "分析完成。根因: {service-name} 的 {component} 出现 {issue-type}" (Analysis complete. Root cause: {issue-type} at {component} in {service-name})

  7. **Agent latency UX copy (from research finding 4):**
     - When user triggers RCA (M-03), immediately show: "正在准备分析环境..." (Preparing analysis environment...) with estimated time range.
     - At 30s without progress: "数据源连接中 — 请稍候" (Connecting to data sources — please wait)
     - At 2min: "分析仍在进行中 — 根因定位通常需要 3-5 分钟" (Analysis in progress — root cause identification typically takes 3-5 minutes)
     - Provide "分析完成后通知我" (Notify me when complete) option for operators who want to work on other tasks.

  **End state:** A comprehensive copy guidelines document at `.design/patterns/copy.md` that any implementation can reference for consistent UX copy across all surfaces.

Acceptance criteria:
  - Voice and tone principles documented: professional, calm, concise, Chinese-primary with English technical terms where standard.
  - Button label convention specified: verb-first, active voice, max 4 characters primary / 6 characters secondary for Chinese labels.
  - Error message three-part hierarchy (title + description + action) documented with Chinese examples.
  - Loading state patterns documented for all agent investigation phases (preparing, analyzing metrics, querying logs, correlating traces, generating report).
  - Empty state patterns documented for 3 scenarios: no RCA history, no matching alerts, no search results — each with action button.
  - Agent investigation step copy templates defined for running/completed/failed states.
  - Agent latency handling copy defined at 3 time thresholds (immediately, 30s, 2min) with optional notification feature.

---

### Task 07 — Polish and Coherence Review
Type: polish
Scope: Final visual coherence review of all design system outputs. Verify visual hierarchy, semantic consistency, design decision traceability, and operator-friendliness (M-09: <=2 clicks for key actions). Audit that every design element serves a functional purpose. This task produces a verification checklist and resolves inconsistencies found during the review.
Depends on: Task 01, Task 02, Task 03, Task 04, Task 05, Task 06
Parallel: false

Reference files:
  - .design/DESIGN-CONTEXT.md
  - .design/DESIGN-PATTERNS.md
  - .design/DESIGN-RESEARCH.md

Action: |
  Perform a comprehensive coherence review of all design system outputs created by Tasks 01-06. Create a review report at `.design/patterns/polish-review.md` that documents findings and any corrections applied. Use the following checklist:

  1. **Visual hierarchy audit:**
     - Verify the primary action on each screen/view is visually dominant (primary button style, top-left or centered placement).
     - Verify secondary actions are visually subordinate (ghost or outline button style).
     - Verify information density is appropriate for ops users: data displays use compact spacing (Tailwind spacing-1/spacing-2), reading/monitoring views use generous spacing (spacing-4/spacing-6).
     - Verify the <2 click rule (M-09): every key action (trigger RCA, view active incidents, access history) is reachable within 2 clicks from the dashboard home. Document any violation.

  2. **Color semantic audit:**
     - Verify color is used ONLY for semantic meaning, never for decoration.
     - Verify no color token is defined that has no functional use in the UI.
     - Verify status colors (green/red/amber/blue) are exclusive to incident status — not reused for unrelated purposes.
     - Verify the dark gray canvas rule (no pure black, use #1a1b1e range) is consistently applied across all surface tokens.

  3. **Typography consistency check:**
     - Verify all text sizes reference the defined type scale (no values outside: 12/13/14/16/18/20/24/30/36px).
     - Verify monospace font is specified for all data surfaces: metric values, timestamps, trace IDs, log output, structured data labels.
     - Verify tabular-nums is enabled on monospace text for aligned number display.
     - Verify line heights match the spec (tight 1.15 for headings, normal 1.5 for body, data-dense 1.3 for tables).

  4. **Design decision traceability map:**
     - Create a mapping table documenting which D-XX decision and M-XX must-have each design pattern addresses:
       - D-07 (Minimal Operator UI) -> Tasks 01, 03, 06, 07
       - D-10 (Single-Tenant RBAC) -> Task 03 (role-aware nav)
       - D-11 (Concurrency Limit) -> Task 03 (queue display), Task 06 (queue copy)
       - M-01 (Rule Config UI) -> Task 03 (wizard pattern), Task 06 (form copy)
       - M-03 (Manual RCA) -> Task 03 (dashboard trigger), Task 06 (trigger copy)
       - M-05 (Agent Progress Streaming) -> Task 04 (step animation), Task 06 (progress copy)
       - M-07 (RCA History) -> Task 03 (timeline pattern), Task 06 (empty state copy)
       - M-09 (<=2 clicks) -> Task 07 (verify)
       - M-10 (Dark gray canvas) -> Task 01 (color tokens), Task 07 (verify)
       - M-11 (Color+icon+label status) -> Task 05 (accessibility pattern)
       - M-12 (Monospace data typography) -> Task 01 (font tokens), Task 07 (verify)

  5. **Final consistency verification:**
     - Verify no component spec references a token or variable that doesn't exist in the token system.
     - Verify all patterns reference shadcn/ui components where applicable (e.g., Sheet for drawers, Badge for status, Progress for agent progress).
     - Verify copy guidelines use terms consistent with DESIGN-CONTEXT.md domain vocabulary (RCA, 应急协同, 故障定界, Hermes Agent).
     - Verify no light-theme-first patterns leaked in (dark theme is default and only theme for v1).

  6. **Correction pass:**
     - For any inconsistency or violation found, update the relevant design artifact (token file, pattern doc, or component spec) directly.
     - Document all corrections in the review report with before/after.

  **End state:** All design system artifacts are internally consistent, fully traceable to design decisions, and verified against the 9 original must-haves plus the 3 plan-specific must-haves. A review report documents the check results and any corrections applied.

Acceptance criteria:
  - Visual hierarchy audit confirms key actions are reachable within 2 clicks from dashboard home, OR documents specific violations with remediation plan.
  - Color semantic audit confirms no decorative color usage; status colors are exclusive to incident states.
  - Typography consistency check confirms all sizes are from the defined scale; monospace is specified for all data surfaces.
  - Design decision traceability map created, mapping every design artifact to at least one D-XX or M-XX code.
  - No component spec references an undefined token or variable.
  - Review report documents any corrections applied and the final state of all design artifacts.

---

## Must-Haves (checked during Verify)

- M-01: Operator can configure alert to RCA trigger rules via UI
- M-02: Incoming alert matching a rule automatically starts an RCA agent session
- M-03: Operator can manually trigger RCA by selecting a time window in the UI
- M-04: RCA trigger automatically creates a WeCom group and sends initial incident context
- M-05: Agent investigation progress appears as messages in the WeCom group in real-time
- M-06: Group members can @bot to submit manual findings, reflected in the RCA context
- M-07: Complete RCA history is viewable in the platform UI (timeline + findings)
- M-08: Emergency collaboration events are recorded in history
- M-09: UI is minimal and operator-friendly, key actions accessible in under 2 clicks
- M-10: All color tokens use dark gray canvas (#1a1b1e range), never pure black
- M-11: Status indicators use color + icon + label, never color alone
- M-12: Monospace typography used for all data surfaces (metrics, timestamps, trace IDs, log output)

## Deferred

- **Full page/wireframe mockups**: The design stage produces token definitions and pattern documentation, not full page designs. Page-level visual design and wireframes are deferred to the implementation stage after the design system foundation is validated.
- **Custom icon sets beyond Lucide**: shadcn/ui ships with Lucide icons by default. Custom iconography for 六脉 branding is deferred — the pattern documentation references Lucide icon names where icons are needed.
- **Light theme support**: DESIGN-CONTEXT.md specifies "dark theme preferred for ops scenarios" (D-07). Light theme is deferred to a future cycle. All design artifacts assume dark theme as the sole theme for v1.
- **Mobile and tablet responsive design**: The ops platform targets desktop-first usage. Tablet support (minimum 1024px) is documented in the layout pattern (Task 03), but mobile layouts below 1024px are deferred.
- **Hermes Agent skill UI**: The interface for managing, testing, or hot-reloading Hermes Skills (referenced in D-03, D-12) is deferred — the v1 scope covers only RCA trigger rules and result viewing, not skill management.
- **WeCom bot configuration UI**: The UI for configuring the WeCom self-built app integration (API keys, WebSocket settings) is deferred. v1 assumes this is configured at deployment time via environment variables or Hermes Gateway configuration.
- **Reference files that do not exist yet**: `reference/anti-patterns.md`, `reference/accessibility.md`, `reference/heuristics.md`, `reference/motion.md`, `reference/typography.md` — these files do not exist as this is a greenfield project. The plan references DESIGN-CONTEXT.md, DESIGN-PATTERNS.md, and DESIGN-RESEARCH.md as the available reference sources. Task executors should proceed without these missing reference files.

---

## PLANNING COMPLETE
