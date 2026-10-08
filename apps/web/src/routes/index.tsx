import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LandingPage } from "~/components/landing/landing-page";
import { authClient } from "~/lib/auth/auth-client";
import { pageMeta } from "~/lib/page-meta";
import { getLocalStorageItem, LOCAL_STORAGE_KEY } from "~/lib/storage/storage";

/**
 * `/`: landing for visitors, redirect to `/chat` for signed-in users.
 * Before the session resolves, a localStorage hint picks the first frame,
 * so first paint never waits on `useSession()`. A hint, never a security check.
 */
export const Route = createFileRoute("/")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ path: "/" }),
  component: IndexRoute,
});

function IndexRoute() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const isAuthed = !!session?.user;

  useEffect(() => {
    if (isAuthed) void navigate({ to: "/chat", replace: true });
  }, [isAuthed, navigate]);

  // The redirect is in flight.
  if (isAuthed) return null;

  // Do not flash the landing at a returning user before the redirect.
  if (isPending && getLocalStorageItem(LOCAL_STORAGE_KEY.MAYBE_AUTHED)) return null;

  return <LandingPage />;
}
