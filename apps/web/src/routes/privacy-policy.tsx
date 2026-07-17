import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PrivacyPolicyPage } from "./-legal/privacy-policy-page";

/**
 * Public privacy policy — `/privacy-policy`. Linked from the landing footer
 * and registered as the OAuth consent-screen privacy link, so it must be
 * reachable without authentication. Renders chromeless via the `chromeless`
 * set in `app-shell.tsx`.
 *
 * Written for Google OAuth verification: discloses exactly which Google user
 * data Alfred accesses, why, how it's stored and shared, and includes the
 * Limited Use statement required for sensitive/restricted Gmail, Calendar,
 * and Drive scopes.
 */
export const Route = createFileRoute("/privacy-policy")({
  head: () => pageMeta({ title: "Privacy Policy", path: "/privacy-policy" }),
  component: PrivacyPolicyPage,
});
