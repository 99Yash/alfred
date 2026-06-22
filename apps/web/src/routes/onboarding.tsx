import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { OnboardingRoute, type OnboardingStep } from "./-onboarding/onboarding-route";

/* `?step=N` is the source of truth for which step renders. Defaulting to 1
 * keeps a bare `/onboarding` visit landing on Unlock; the Google callback
 * redirects with `step=2` to advance the funnel. */
export const Route = createFileRoute("/onboarding")({
  head: () => pageMeta({ title: "Get started", path: "/onboarding" }),
  validateSearch: (
    search,
  ): { step: OnboardingStep; google_connected?: string; github_connected?: string } => {
    const raw = Number((search as { step?: unknown }).step);
    const step: OnboardingStep = raw === 2 ? 2 : raw === 3 ? 3 : 1;
    const google = (search as { google_connected?: unknown }).google_connected;
    const github = (search as { github_connected?: unknown }).github_connected;
    return {
      step,
      google_connected: typeof google === "string" ? google : undefined,
      github_connected: typeof github === "string" ? github : undefined,
    };
  },
  component: OnboardingRoute,
});
