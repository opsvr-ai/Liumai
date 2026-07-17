import { Component, type ReactNode, type ErrorInfo } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ==========================================================================
 *  ErrorBoundary — Application-Level Error Boundary
 *
 *  Catches unhandled rendering errors and displays a fallback UI with
 *  error details and a recovery action (reload).
 *
 *  Usage:
 *    <ErrorBoundary>
 *      <App />
 *    </ErrorBoundary>
 *
 *  Reference: copy.md Section 4.3 (error state patterns)
 *             accessibility.md Section 6.5 (role="alert")
 * ========================================================================== */

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback UI */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Unhandled error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center min-h-[200px] p-6" role="alert">
          <Alert variant="destructive" className="max-w-md">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>应用发生错误</AlertTitle>
            <AlertDescription>
              {this.state.error?.message ?? "发生了意外错误，请刷新页面后重试。"}
            </AlertDescription>
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.reload()}
              >
                刷新页面
              </Button>
            </div>
          </Alert>
        </div>
      );
    }

    return this.props.children;
  }
}
