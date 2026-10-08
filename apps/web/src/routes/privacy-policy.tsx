import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PrivacyPolicyPage } from "./-legal/privacy-policy-page";

/**
 * Public `/privacy-policy`, also the OAuth consent-screen link, so no auth.
 * Written for Google OAuth verification, with the Limited Use statement.
 */
export const Route = createFileRoute("/privacy-policy")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ title: "Privacy Policy", path: "/privacy-policy" }),
  component: PrivacyPolicyPage,
});
