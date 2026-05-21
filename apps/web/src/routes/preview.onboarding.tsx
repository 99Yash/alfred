import { createFileRoute, useSearch } from "@tanstack/react-router";
import { OnboardingFlow } from "~/components/onboarding/onboarding-flow";

/**
 * Preview of the dimension-grammar onboarding flow — accessible at
 * `/preview/onboarding[?step=N]` regardless of auth state. The real
 * `/onboarding` route remains gated behind a session.
 */
export const Route = createFileRoute("/preview/onboarding")({
  validateSearch: (search): { step?: 1 | 2 | 3 } => {
    const raw = Number((search as { step?: unknown }).step);
    return { step: raw === 2 ? 2 : raw === 3 ? 3 : 1 };
  },
  component: PreviewOnboarding,
});

function PreviewOnboarding() {
  const { step } = useSearch({ from: "/preview/onboarding" });
  return (
    <OnboardingFlow
      step={step ?? 1}
      connectedEmail="alex@alfred.beauty"
      onConnect={() => undefined}
      onSkip={() => undefined}
      onFinish={() => undefined}
      finishing={false}
    />
  );
}
