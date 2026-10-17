/** Effective fine-grained permissions for the signed-in user.
 *
 * The backend derives permissions from the user's role (``ADMIN`` /
 * ``OPERATOR`` / ``VIEWER``) and serves them from ``GET /api/auth/permissions``.
 * The chat UI must never guess: a missing permission hides the matching
 * mutating control (see ``<PermissionGate>``).
 *
 * Caching
 * -------
 * One in-memory snapshot is shared by every component on the page, so mounting
 * several gated widgets issues a single request.  A successful snapshot is
 * fresh for five minutes; the cache is keyed by the auth token so switching
 * accounts in the same tab cannot inherit the previous user's bits.
 *
 * Failure is conservative: the hook resolves to an empty set, which keeps every
 * gated control hidden instead of flashing something the user cannot use.  A
 * failure is retried after a short TTL rather than being cached for the full
 * five minutes.
 */

import { useCallback, useEffect, useState } from "react";
import { authApi } from "@/lib/api";

/** Hard TTL for a successful permission snapshot. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Retry window after a failed read — never hide controls for five minutes. */
const FAILURE_TTL_MS = 30 * 1000;

export interface PermissionsSnapshot {
  permissions: Set<string>;
  role: string | null;
}

interface CacheEntry extends PermissionsSnapshot {
  /** Auth token the snapshot belongs to (invalidation key). */
  token: string | null;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

function readToken(): string | null {
  try {
    return localStorage.getItem("liumai_token");
  } catch {
    return null;
  }
}

function isUsable(entry: CacheEntry | null, token: string | null): entry is CacheEntry {
  return entry !== null && entry.token === token && Date.now() < entry.expiresAt;
}

function emptyEntry(token: string | null): CacheEntry {
  return {
    permissions: new Set<string>(),
    role: null,
    token,
    expiresAt: Date.now() + FAILURE_TTL_MS,
  };
}

/** Resolve the snapshot, reusing the shared cache / in-flight request. */
function loadPermissions(token: string | null): Promise<CacheEntry> {
  if (isUsable(cache, token)) return Promise.resolve(cache);

  if (inflight) return inflight;

  inflight = authApi
    .permissions()
    .then((res) => {
      const entry: CacheEntry = {
        permissions: new Set(res.permissions ?? []),
        role: res.role ?? null,
        token,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      cache = entry;
      return entry;
    })
    .catch(() => {
      // Conservative: no bits → every gate stays hidden.  Short TTL so a
      // transient failure recovers on the next mount / navigation.
      cache = emptyEntry(token);
      return cache;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Drop the cached snapshot (used by tests / account switches). */
export function clearPermissionsCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Read the current user's permission set once and expose a stable ``has`` check.
 *
 * @returns ``permissions`` (empty on failure / while loading), ``has(perm)``,
 *          the raw ``role`` and a ``loading`` flag so gates can render their
 *          fallback instead of briefly showing a control that must be hidden.
 */
export function usePermissions() {
  const initialToken = readToken();
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot>(() =>
    isUsable(cache, initialToken)
      ? { permissions: cache.permissions, role: cache.role }
      : { permissions: new Set<string>(), role: null },
  );
  const [loading, setLoading] = useState<boolean>(() => !isUsable(cache, initialToken));

  useEffect(() => {
    let cancelled = false;
    const token = readToken();

    loadPermissions(token).then((entry) => {
      if (cancelled) return;
      setSnapshot({ permissions: entry.permissions, role: entry.role });
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const has = useCallback(
    (perm: string) => snapshot.permissions.has(perm),
    [snapshot.permissions],
  );

  return {
    permissions: snapshot.permissions,
    has,
    role: snapshot.role,
    loading,
  } as const;
}
