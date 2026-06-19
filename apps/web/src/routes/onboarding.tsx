import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { useEffect, useState } from "react";
import { OnboardingFlow } from "~/components/onboarding/onboarding-flow";
import { useConnectedAccountLabel } from "~/hooks/use-integration-status";
import { authClient } from "~/lib/auth/auth-client";
import { client } from "~/lib/eden";
import { toast } from "~/lib/toast";

type OnboardingStep = 1 | 2 | 3;

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

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export function OnboardingRoute() {
  const { step, google_connected, github_connected } = useSearch({ from: "/onboarding" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [finishing, setFinishing] = useState(false);

  // Each OAuth callback redirects back with only its own `?*_connected`
  // param, so the URL alone can't show both badges at once. Fall back to
  // live credential state for whichever param the current URL is missing.
  const googleAccount = useConnectedAccountLabel("google");
  const githubAccount = useConnectedAccountLabel("github");
  const connectedEmail = google_connected ?? googleAccount ?? undefined;
  const connectedGithub = github_connected ?? githubAccount ?? undefined;

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
      // Eden returns `{ data, error }` — a failed POST resolves (it doesn't
      // throw), so the catch alone never sees a 4xx/5xx. Inspect `error` and
      // bail before navigating: only on success should we invalidate the
      // gating query and route home. Otherwise the query still reports
      // routeToOnboarding=true and AppShell bounces us straight back here,
      // producing a redirect flicker instead of an actionable error state.
      const { error } = await client.api.me.onboarding.complete.post();
      if (error) {
        throw new Error(`onboarding complete failed (${error.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["me", "onboarding"] });
      await navigate({ to: "/" });
    } catch (err) {
      console.warn("[onboarding] failed to mark complete:", err);
      toast.error({
        message: "Couldn't finish setup",
        description: "Something went wrong on our end. Please try again.",
      });
    } finally {
      setFinishing(false);
    }
  };

  return (
    <OnboardingFlow
      step={step}
      connectedEmail={connectedEmail}
      connectedGithub={connectedGithub}
      onConnect={() => {
        // Full-page redirect to the API connect endpoint (which 302s to Google).
        window.location.href = `${API_URL}/api/integrations/google/connect`;
      }}
      onConnectGithub={() => {
        // GitHub's callback 302s back to /onboarding?step=2&github_connected=…
        window.location.href = `${API_URL}/api/integrations/github/connect`;
      }}
      onSkip={() => goToStep(3)}
      onFinish={() => {
        void finish();
      }}
      finishing={finishing}
    />
  );
}
