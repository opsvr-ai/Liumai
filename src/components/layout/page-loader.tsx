import { Skeleton } from "@/components/ui/skeleton";

/**
 * Suspense fallback for lazily-loaded pages.
 * Mirrors the common page chrome (title + stat cards + table) so the layout
 * does not jump while the async chunk is fetched.
 */
export function PageLoader() {
  return (
    <div
      className="mx-auto max-w-6xl space-y-6 p-4 md:p-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[4.5rem] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <span className="sr-only">页面加载中</span>
    </div>
  );
}

/** Suspense fallback used before the app shell itself is mounted. */
export function BootLoader() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background text-foreground">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary"
        role="status"
        aria-label="加载中"
      />
    </div>
  );
}
