import { createContext, use, useEffect, useState } from "react";
import { authClient } from "~/lib/auth-client";
import type { AlfredReplicache } from "./client";

const ReplicacheContext = createContext<AlfredReplicache | null>(null);

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [rep, setRep] = useState<AlfredReplicache | null>(null);

  useEffect(() => {
    if (!userId) return;
    // Dynamically import the client so the Replicache library stays out of the
    // entry chunk — logged-out visitors (e.g. the landing page) never fetch it.
    let cancelled = false;
    let close: (() => void) | undefined;

    // The chunk load can fail (flaky network, CDN outage, stale hash after a
    // deploy). Without a catch that's an unhandled rejection and `rep` stays
    // null forever with no recovery until a manual reload. Retry transient
    // failures with backoff; log loudly if it never loads. `createReplicache`
    // is synchronous, so the instance-create + close-capture below stays
    // atomic w.r.t. the cleanup (no leak window).
    const MAX_ATTEMPTS = 3;
    const load = async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          const { createReplicache } = await import("./client");
          if (cancelled) return;
          const instance = createReplicache(userId);
          close = instance.close;
          setRep(instance.rep);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt === MAX_ATTEMPTS) {
            console.error(
              "[replicache] failed to load client; sync disabled until reload",
              err,
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    };
    void load();

    return () => {
      cancelled = true;
      setRep(null);
      close?.();
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
