/**
 * The router's `defaultErrorComponent`: a recoverable panel instead of a white screen.
 * Sentry loads lazily, so it stays out of the main bundle.
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
              // Clear the router's error and re-run the route's loaders.
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

/** The router's `defaultNotFoundComponent`. */
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
