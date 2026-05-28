import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsPage } from "~/components/approvals/approvals-page";
import { authClient } from "~/lib/auth-client";

/**
 * Live `/approvals` surface. Subscribes to pending `action_stagings` via
 * Replicache and posts approve / reject / cancel decisions through the Eden
 * decision API (`POST /api/approvals/:stagingId/decision`).
 *
 * Auth is gated here, not in the Replicache hook: `useActionStagings` returns
 * `loading` whenever no client exists, which is true both while the session
 * resolves *and* when nobody is signed in. Collapsing those would spin the
 * loader forever for signed-out visitors, so we split them at the route —
 * `useActionStagings` stays purely about Replicache readiness.
 *
 * The fixture-driven design reference still lives at
 * `routes/-preview-approvals` for visual iteration without the auth/sync
 * plumbing. Signed-out/pending states render outside the themed app chrome
 * (see `AppShell`'s `showChrome`), so they use plain grammar like
 * `routes/debug.events.tsx` rather than the `vs-*` tokens.
 */
export const Route = createFileRoute("/approvals")({
  component: ApprovalsRoute,
});

function ApprovalsRoute() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <p className="text-muted-foreground">Sign in to review pending approvals.</p>
          <a href="/login" className="text-sm underline">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return <ApprovalsPage />;
}
