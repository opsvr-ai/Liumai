/* ==========================================================================
 *  六脉 (Liumai) — Component Authoring Conventions
 *
 *  File Organization:
 *    src/components/ui/          — shadcn/ui-generated components
 *    src/components/[feature]/   — Custom feature components
 *                               (e.g., rca/, alerts/, collaboration/)
 *    src/lib/                    — Shared utilities (cn(), formatters)
 *    src/hooks/                  — Custom React hooks
 *    src/styles/globals.css      — Single source of truth for all tokens
 *
 *  Class Merging:
 *    Use `cn(...)` from this file instead of raw `clsx` or template
 *    literals. `cn()` merges Tailwind classes and resolves conflicts
 *    (last truthy value wins). Always import from `@/lib/utils`.
 *
 *  Custom Variants:
 *    Use `cva` from `class-variance-authority` for component variant
 *    definitions. Pattern: define `const XxxVariants = cva(...)` then
 *    apply via `cn(XxxVariants({ variant, size }), className)`.
 *
 *  Import Alias:
 *    All project imports use the `@/` alias → `./src/`.
 *    Example: `import { cn } from "@/lib/utils"`
 *             `import { Badge } from "@/components/ui/badge"`
 *
 *  Styling:
 *    Tailwind utility classes only. No CSS Modules, no styled-components,
 *    no inline style objects. Tokens from `@theme` in globals.css produce
 *    first-class Tailwind utilities (bg-primary, text-muted-foreground, etc.).
 * ========================================================================== */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
