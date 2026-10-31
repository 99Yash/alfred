import { getStringPath } from "@alfred/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { OnboardingRoute, type OnboardingStep } from "./-onboarding/onboarding-route";

/* `?step=N` picks the step; default 1. The Google callback sends `step=2`. */
interface OnboardingSearch {
  step: OnboardingStep;
  google_connected?: string | undefined;
  github_connected?: string | undefined;
}

export const Route = createFileRoute("/onboarding")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ title: "Get started", path: "/onboarding" }),
  validateSearch: (search): OnboardingSearch => {
    // The router gives a plain object of parsed query values, so read it directly.
    const raw = Number(search["step"]);
    const step: OnboardingStep = raw === 2 ? 2 : raw === 3 ? 3 : 1;

    return {
      step,
      google_connected: getStringPath(search, "google_connected"),
      github_connected: getStringPath(search, "github_connected"),
    };
  },
  component: OnboardingRoute,
});
