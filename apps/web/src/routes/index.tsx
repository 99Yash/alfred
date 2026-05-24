import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { authClient } from "~/lib/auth-client";

/**
 * Root index — `/`.
 *
 * The visitors-now shell makes `/chat` the primary surface (matching what
 * `/preview` did during the dimension/vs A/B). `/` exists only to bounce
 * the user to the right next step:
 *   - signed-in  → `/chat`
 *   - signed-out → `/login`
 *
 * Rendering nothing while `useSession()` resolves prevents a flash of
 * chrome on the very first paint.
 */
export const Route = createFileRoute("/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (isPending) return;
    void navigate({ to: session?.user ? "/chat" : "/login", replace: true });
  }, [isPending, session?.user, navigate]);

  return null;
}
