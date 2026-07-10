import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OnboardingFlow } from "~/components/onboarding/onboarding-flow";
import { useConnectedAccountLabel } from "~/lib/integrations/use-integration-status";
import { authClient } from "~/lib/auth/auth-client";
import { client } from "~/lib/eden";
import { toast } from "~/lib/toast";

export type OnboardingStep = 1 | 2 | 3;

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
      // #229: capture the browser's IANA zone so chat date grounding + briefing
      // delivery don't silently default to UTC. The server persists it to the
      // canonical `timezone` pref only if unset (won't clobber a chosen zone).
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Eden returns `{ data, error }`, a failed POST resolves, so inspect
      // `error` before navigating and invalidating the onboarding gate.
      const { error } = await client.api.me.onboarding.complete.post(
        browserTimezone ? { timezone: browserTimezone } : {},
      );
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
        // GitHub's callback 302s back to /onboarding?step=2&github_connected=...
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
