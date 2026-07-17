import { authClient } from "~/lib/auth/auth-client";
import { ApprovalsPage } from "./approvals-page";

export function ApprovalsRoute() {
  const { isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{"Loading\u2026"}</p>
      </div>
    );
  }

  return <ApprovalsPage />;
}
