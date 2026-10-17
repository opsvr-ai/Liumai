/** Declarative permission gate for mutating UI controls.
 *
 * Usage:
 *
 * ```tsx
 * <PermissionGate perm="rca_terminate" fallback={null}>
 *   <Button onClick={stop}>终止</Button>
 * </PermissionGate>
 * ```
 *
 * Until ``GET /api/auth/permissions`` resolves (and permanently when it fails)
 * the user's permission set is empty, so children stay hidden — a control the
 * backend would reject never flashes on screen.
 */

import type { ReactNode } from "react";
import { usePermissions } from "@/hooks/usePermissions";

export interface PermissionGateProps {
  /** Permission bit from the backend catalog, e.g. ``"rca_terminate"``. */
  perm: string;
  /** Rendered when the permission is missing.  Defaults to ``null`` (hidden). */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Render ``children`` only when the current user holds ``perm``.
 *
 * The gate is intentionally render-only: it hides controls but does not replace
 * backend enforcement (routes keep their ``require_permission`` checks).
 */
export function PermissionGate({
  perm,
  fallback = null,
  children,
}: PermissionGateProps) {
  const { has } = usePermissions();
  return <>{has(perm) ? children : fallback}</>;
}
