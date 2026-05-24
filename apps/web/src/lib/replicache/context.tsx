import { useEffect } from "react";
import { authClient } from "~/lib/auth-client";
import { createReplicache } from "./client";

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    const { close } = createReplicache(userId);
    return close;
  }, [session?.user?.id]);

  return <>{children}</>;
}
