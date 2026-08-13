import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LandingPage } from "~/components/landing/landing-page";
import { authClient } from "~/lib/auth/auth-client";
import { pageMeta } from "~/lib/page-meta";
import { getLocalStorageItem, LOCAL_STORAGE_KEY } from "~/lib/storage/storage";

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
 * resolved session immediately corrects course. It is a UX hint, never a
 * security boundary — `AppShell` writes it, and the key's schema defaults it to
 * `false` (show the landing) for SSR, private mode, and first-ever visits.
 */
export const Route = createFileRoute("/")({
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

  // Confirmed authed → redirect is in flight, render nothing.
  if (isAuthed) return null;
  // Session not yet resolved → defer to the hint to avoid flashing the landing
  // at a returning signed-in user before the redirect fires.
  if (isPending && getLocalStorageItem(LOCAL_STORAGE_KEY.MAYBE_AUTHED)) return null;
  return <LandingPage />;
}
