import { Outlet, useChildMatches } from "@tanstack/react-router";
import { authClient } from "~/lib/auth/auth-client";
import { BriefingsPage } from "./briefings-page";

export function BriefingsRoute() {
  const { data: session, isPending } = authClient.useSession();
  const hasChild = useChildMatches().length > 0;

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <p className="text-muted-foreground">Sign in to view your briefings.</p>
          <a href="/login" className="text-sm underline">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return hasChild ? <Outlet /> : <BriefingsPage />;
}
