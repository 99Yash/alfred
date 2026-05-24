import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LandingPage } from "~/components/landing/landing-page";
import { authClient } from "~/lib/auth-client";

/**
 * Root index — `/`.
 *
 * Authed visitors bounce to `/chat`; unauthed visitors see the marketing
 * landing in place at `/`. `/login` is reachable but no longer the default
 * for signed-out visitors. While `useSession()` resolves we render nothing
 * to avoid a one-frame flash of the landing for users who are about to be
 * routed to `/chat`.
 */
export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (isPending) return;
    if (!session?.user) return;
    void navigate({ to: "/chat", replace: true });
  }, [isPending, session?.user, navigate]);

  if (isPending || session?.user) return null;
  return <LandingPage healthOk={true} healthLoading={false} />;
}
