import { createFileRoute } from "@tanstack/react-router";
import { VisitorsNowPreview } from "./-preview-visitors-now/visitors-now-preview";

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
