/**
 * App-wide error boundary, wired as the router's `defaultErrorComponent`
 * (see `main.tsx`). Catches any uncaught render error in a route subtree so a
 * single throw degrades to a recoverable panel instead of white-screening the
 * whole app.
 *
 * Adapted from the dimension web `ErrorBoundary`, but built on TanStack
 * Router's error-component contract rather than a React class: the router owns
 * the boundary, hands us `{ error, reset }`, and `reset` + `invalidate()` lets
 * us retry the failed render in place before falling back to a hard reload.
 *
 * Sentry is loaded lazily (matching `main.tsx`'s deferred observability init)
 * so `@sentry/react` never lands in the main bundle just to report errors.
 */

import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { RefreshCcw } from "lucide-react";
import { useEffect } from "react";
import { FrostPanel } from "~/components/ui/frost-panel";
import { LegacyButton } from "~/components/ui/legacy/button";

const RELOAD_TRAILING = <RefreshCcw className="size-3.5" />;

export function DefaultCatchBoundary({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  useEffect(() => {
    console.error("Uncaught render error:", error);
    void import("@sentry/react")
      .then((Sentry) => {
        Sentry.captureException(error);
      })
      .catch(() => {});
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
      <FrostPanel className="flex max-w-md flex-col items-center gap-3 p-6">
        <p className="text-sm font-medium text-foreground">Something went wrong.</p>
        <p className="text-sm text-muted-foreground">
          An unexpected error happened while rendering this page.
        </p>

        <div className="mt-2 flex items-center gap-2">
          <LegacyButton
            variant="ghost"
            size="md"
            onClick={() => {
              // Retry the failed render in place: clear the router's error
              // state, then re-run the route's loaders/queries.
              reset();
              void router.invalidate();
            }}
          >
            Try again
          </LegacyButton>
          <LegacyButton
            variant="primary"
            size="md"
            trailing={RELOAD_TRAILING}
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload page
          </LegacyButton>
        </div>
      </FrostPanel>
    </div>
  );
}

/**
 * App-wide 404, wired as the router's `defaultNotFoundComponent` (see
 * `main.tsx`). Renders when a route doesn't match or a loader throws
 * `notFound()`.
 */
export function NotFound() {
  const router = useRouter();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 text-center">
      <FrostPanel className="flex max-w-md flex-col items-center gap-3 p-6">
        <p className="text-sm font-medium text-foreground">Page not found.</p>
        <p className="text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>

        <div className="mt-2 flex items-center gap-2">
          <LegacyButton
            variant="ghost"
            size="md"
            onClick={() => {
              window.history.back();
            }}
          >
            Go back
          </LegacyButton>
          <LegacyButton
            variant="primary"
            size="md"
            onClick={() => {
              void router.navigate({ to: "/" });
            }}
          >
            Go home
          </LegacyButton>
        </div>
      </FrostPanel>
    </div>
  );
}
