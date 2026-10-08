import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { TermsOfServicePage } from "./-legal/terms-of-service-page";

/** Public `/terms-of-service`, also on the OAuth consent screen, so no auth. */
export const Route = createFileRoute("/terms-of-service")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ title: "Terms of Service", path: "/terms-of-service" }),
  component: TermsOfServicePage,
});
