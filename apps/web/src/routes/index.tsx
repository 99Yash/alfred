import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "~/lib/auth-client";
import { client } from "~/lib/eden";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data, isLoading } = useQuery({
    queryKey: ["health"],
    queryFn: () => client.health.get(),
  });

  const signOut = async () => {
    await authClient.signOut();
    await navigate({ to: "/login" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Alfred</h1>
        <p className="text-muted-foreground">
          Server:{" "}
          {isLoading
            ? "checking…"
            : data?.data && "ok" in data.data && data.data.ok
              ? "✓ connected"
              : "✗ not reachable"}
        </p>
        {sessionPending ? null : session?.user ? (
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <span>{session.user.email}</span>
            <a href="/notes" className="underline">
              Notes
            </a>
            <button onClick={signOut} className="underline">
              Sign out
            </button>
          </div>
        ) : (
          <a href="/login" className="underline text-sm">
            Sign in
          </a>
        )}
      </div>
    </div>
  );
}
