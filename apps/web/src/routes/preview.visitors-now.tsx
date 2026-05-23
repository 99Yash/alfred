import { createFileRoute } from "@tanstack/react-router";
import { VsThemeProvider } from "~/components/ui/visitors";
import { VsThemedPreview } from "./-preview-visitors-now/vs-themed-preview";

/**
 * Preview of the visitors-now-grammar primitives. Recreates the
 * dashboard layout from archive/visitors-now/screenshots/dashboard-1440.png
 * so we can A/B against the source material without leaving the app.
 *
 * Mounted at /preview/visitors-now regardless of auth state.
 */
export const Route = createFileRoute("/preview/visitors-now")({
  component: VisitorsNowPreview,
});

function VisitorsNowPreview() {
  return (
    <VsThemeProvider>
      <VsThemedPreview />
    </VsThemeProvider>
  );
}
