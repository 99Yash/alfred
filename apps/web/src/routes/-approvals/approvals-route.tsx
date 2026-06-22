import { ApprovalsPage } from "~/components/approvals/approvals-page";
import { authClient } from "~/lib/auth/auth-client";

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
