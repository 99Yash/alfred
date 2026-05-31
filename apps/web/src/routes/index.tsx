import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LandingPage } from "~/components/landing/landing-page";
import { authClient } from "~/lib/auth-client";

/**
 * Root index — `/`.
 *
 * Unauthed visitors see the marketing landing in place at `/`; authed visitors
 * bounce to `/chat`. We render the landing immediately rather than waiting for
 * `useSession()` to resolve — blocking first paint on the get-session
 * round-trip penalises every (overwhelmingly logged-out) marketing visitor to
 * spare the rare authed-hits-`/` case a one-frame flash before redirect. FCP
 * wins that trade for a public page.
 */
export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const isAuthed = !!session?.user;

  useEffect(() => {
    if (isAuthed) void navigate({ to: "/chat", replace: true });
  }, [isAuthed, navigate]);

  // Hide only once we positively know the user is authed (redirect is in
  // flight). Until then — including while the session is still pending — paint
  // the landing.
  if (isAuthed) return null;
  return <LandingPage healthOk={true} healthLoading={false} />;
}
