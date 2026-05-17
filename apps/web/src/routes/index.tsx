import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "~/lib/auth-client";
import { client } from "~/lib/eden";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data, isLoading } = useQuery({
    queryKey: ["health"],
    queryFn: () => client.health.get(),
  });

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
        {sessionPending || session?.user ? null : (
          <a href="/login" className="underline text-sm">
            Sign in
          </a>
        )}
      </div>
    </div>
  );
}
