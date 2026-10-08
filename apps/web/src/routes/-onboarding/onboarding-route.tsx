import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OnboardingFlow, type OnboardingStep } from "~/components/onboarding/onboarding-flow";
import { useConnectedAccountLabel } from "~/lib/integrations/use-integration-status";
import { writeOnboardingHint } from "~/lib/onboarding/onboarding-hint";
import { authClient } from "~/lib/auth/auth-client";
import { client, API_URL } from "~/lib/eden";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";
import { toast } from "~/lib/toast";

export type { OnboardingStep };

export function OnboardingRoute() {
  const { step, google_connected, github_connected } = useSearch({ from: "/onboarding" });
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const [finishing, setFinishing] = useState(false);

  // Each callback returns with only its own `?*_connected` param, so fall back to live credential state.
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
      // Send the browser zone so dates and briefings do not default to UTC. The server keeps a zone already set.
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Eden resolves a failed POST, so check `error` before leaving.
      const { error } = await client.api.me.onboarding.complete.post(
        browserTimezone ? { timezone: browserTimezone } : {},
      );

      if (error) {
        throw new Error(`onboarding complete failed (${error.status})`);
      }

      // Seed the hint, then do a full-page navigation. The SPA path raced the
      // `AppShell` guard, which read a stale `false` and sent the user back to `/onboarding`.
      writeOnboardingHint(session.user.id, true);
      window.location.assign("/");
      // Keep `finishing` true so the button label does not flip back during unload.
    } catch (err) {
      console.warn("[onboarding] failed to mark complete:", err);
      toast.error({
        message: "Couldn't finish setup",
        description: "Something went wrong on our end. Please try again.",
      });
      setFinishing(false);
    }
  };

  return (
    <OnboardingFlow
      step={step}
      connectedEmail={connectedEmail}
      connectedGithub={connectedGithub}
      onConnect={() => {
        // New tab; the live credential read above shows the badge when this tab regains focus.
        openAuthorizationTab(`${API_URL}/api/integrations/google/connect`);
      }}
      onConnectGithub={() => {
        openAuthorizationTab(`${API_URL}/api/integrations/github/connect`);
      }}
      onSkip={() => goToStep(3)}
      onFinish={() => {
        void finish();
      }}
      finishing={finishing}
    />
  );
}
