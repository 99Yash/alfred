import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LandingPage } from "~/components/landing/landing-page";
import { authClient } from "~/lib/auth-client";
import { readAuthHint } from "~/lib/auth-hint";
import { pageMeta } from "~/lib/page-meta";
import { useHealth } from "~/lib/use-health";

/**
 * Root index — `/`.
 *
 * Unauthed visitors see the marketing landing in place at `/`; authed visitors
 * bounce to `/chat`. We never block first paint on the `useSession()`
 * round-trip — that would penalise every (overwhelmingly logged-out) marketing
 * visitor. Instead, for the first frame before the session resolves, we trust a
 * synchronous localStorage hint of the last known auth state:
 *   • no hint / signed-out  → paint the landing immediately (fast FCP, no flash)
 *   • signed-in             → hold a blank frame for the `/chat` redirect
 *                             (no flash of the marketing page)
 * A stale hint only ever costs a one-frame flash or a brief blank, and the
 * resolved session immediately corrects course. See `lib/auth-hint`.
 */
export const Route = createFileRoute("/")({
  head: () => pageMeta({ path: "/" }),
  component: IndexRoute,
});

function IndexRoute() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const isAuthed = !!session?.user;
  const { healthOk, healthLoading } = useHealth();

  useEffect(() => {
    if (isAuthed) void navigate({ to: "/chat", replace: true });
  }, [isAuthed, navigate]);

  // Confirmed authed → redirect is in flight, render nothing.
  if (isAuthed) return null;
  // Session not yet resolved → defer to the hint to avoid flashing the landing
  // at a returning signed-in user before the redirect fires.
  if (isPending && readAuthHint()) return null;
  return <LandingPage healthOk={healthOk} healthLoading={healthLoading} />;
}
