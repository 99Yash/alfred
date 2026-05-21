import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OnboardingFlow } from "~/components/onboarding/onboarding-flow";
import { authClient } from "~/lib/auth-client";
import { client } from "~/lib/eden";

type OnboardingStep = 1 | 2 | 3;

/* `?step=N` is the source of truth for which step renders. Defaulting to 1
 * keeps a bare `/onboarding` visit landing on Unlock; the Google callback
 * redirects with `step=2` to advance the funnel. */
export const Route = createFileRoute("/onboarding")({
  validateSearch: (search): { step: OnboardingStep; google_connected?: string } => {
    const raw = Number((search as { step?: unknown }).step);
    const step: OnboardingStep = raw === 2 ? 2 : raw === 3 ? 3 : 1;
    const connected = (search as { google_connected?: unknown }).google_connected;
    return {
      step,
      google_connected: typeof connected === "string" ? connected : undefined,
    };
  },
  component: OnboardingRoute,
});

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ??
  "http://localhost:3001";

function OnboardingRoute() {
  const { step, google_connected } = useSearch({ from: "/onboarding" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (!isPending && !session?.user) {
      void navigate({ to: "/login" });
    }
  }, [isPending, session, navigate]);

  if (isPending || !session?.user) {
    return <div className="min-h-[100dvh]" aria-hidden />;
  }

  const goToStep = (next: OnboardingStep) => {
    void navigate({ to: "/onboarding", search: { step: next } });
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await client.api.me.onboarding.complete.post();
    } catch (err) {
      console.warn("[onboarding] failed to mark complete:", err);
    } finally {
      // Bust the gating query so AppShell doesn't bounce us straight back.
      await queryClient.invalidateQueries({ queryKey: ["me", "onboarding"] });
      await navigate({ to: "/" });
      setFinishing(false);
    }
  };

  return (
    <OnboardingFlow
      step={step}
      connectedEmail={google_connected}
      onConnect={() => {
        // Full-page redirect to the API connect endpoint (which 302s to Google).
        window.location.href = `${API_URL}/api/integrations/google/connect`;
      }}
      onSkip={() => goToStep(3)}
      onFinish={() => {
        void finish();
      }}
      finishing={finishing}
    />
  );
}
