import { getStringPath, toRecord } from "@alfred/contracts";
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
    const params = toRecord(search);
    const raw = Number(params.step);
    const step: OnboardingStep = raw === 2 ? 2 : raw === 3 ? 3 : 1;
    return {
      step,
      google_connected: getStringPath(params, "google_connected"),
      github_connected: getStringPath(params, "github_connected"),
    };
  },
  component: OnboardingRoute,
});
