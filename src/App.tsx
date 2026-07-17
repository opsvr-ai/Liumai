import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function App() {
  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-background text-foreground p-8" role="application">
        {/* aria-live region for dynamic status announcements */}
        <div aria-live="polite" role="status" className="sr-only" id="status-announcements" />
        <h1 className="text-2xl font-bold">六脉 — 智能化运维数智平台</h1>
        <p className="text-muted-foreground mt-2">shadcn/ui component foundation ready.</p>
      </div>
    </ErrorBoundary>
  );
}
