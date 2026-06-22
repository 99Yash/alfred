import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { TermsOfServicePage } from "./-legal/terms-of-service-page";

/**
 * Public terms of service — `/terms-of-service`. Linked from the landing
 * footer and registered on the OAuth consent screen, so it must be reachable
 * without authentication. Renders chromeless via the `chromeless` set in
 * `app-shell.tsx`.
 */
export const Route = createFileRoute("/terms-of-service")({
  head: () => pageMeta({ title: "Terms of Service", path: "/terms-of-service" }),
  component: TermsOfServicePage,
});
