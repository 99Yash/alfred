import { createContext, use, useEffect, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { type AlfredReplicache, createReplicache } from "./client";

const ReplicacheContext = createContext<AlfredReplicache | null>(null);

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [rep, setRep] = useState<AlfredReplicache | null>(null);

  useEffect(() => {
    if (!userId) return;
    const { rep: instance, close } = createReplicache(userId);
    setRep(instance);
    return () => {
      setRep(null);
      close();
    };
  }, [userId]);

  return <ReplicacheContext.Provider value={rep}>{children}</ReplicacheContext.Provider>;
}

/**
 * The live Replicache instance, or `null` before sign-in / while the client
 * is (re)initializing. Subscription hooks must treat `null` as "not ready".
 */
export function useReplicache(): AlfredReplicache | null {
  return use(ReplicacheContext);
}
