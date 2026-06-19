import { createContext, use, useEffect, useMemo, useState } from "react";
import { authClient } from "~/lib/auth/auth-client";
import type { AlfredReplicache } from "./client";

interface ReplicacheContextValue {
  rep: AlfredReplicache | null;
  loadError: string | null;
  retry: () => void;
}

const ReplicacheContext = createContext<ReplicacheContextValue>({
  rep: null,
  loadError: null,
  retry: () => {},
});

/**
 * Shown across every synced surface when the data path starts 401ing — the
 * session cookie expired while the tab stayed open. Without this, pull/push
 * retry forever and the UI silently serves stale data with no signal.
 */
const SESSION_EXPIRED_MESSAGE = "Your session expired. Please sign in again.";

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [rep, setRep] = useState<AlfredReplicache | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const contextValue = useMemo<ReplicacheContextValue>(
    () => ({ rep, loadError, retry: () => setRetryNonce((nonce) => nonce + 1) }),
    [loadError, rep],
  );

  useEffect(() => {
    if (!userId) {
      setRep(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    let close: (() => void) | undefined;

    // Set once on the first 401 — Replicache retries the pull/push forever, so
    // onAuthError fires repeatedly; collapse that to a single state update.
    const handleAuthError = () => {
      if (cancelled) return;
      setLoadError((prev) => prev ?? SESSION_EXPIRED_MESSAGE);
    };

    const MAX_ATTEMPTS = 3;
    const load = async () => {
      setLoadError(null);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          const { createReplicache } = await import("./client");
          if (cancelled) return;
          const instance = createReplicache(userId, { onAuthError: handleAuthError });
          close = instance.close;
          setRep(instance.rep);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt === MAX_ATTEMPTS) {
            setLoadError(
              err instanceof Error
                ? `Sync client failed to load: ${err.message}`
                : "Sync client failed to load.",
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
  }, [userId, retryNonce]);

  return <ReplicacheContext.Provider value={contextValue}>{children}</ReplicacheContext.Provider>;
}

/**
 * The live Replicache instance, or `null` before sign-in / while the client
 * is (re)initializing. Subscription hooks must treat `null` as "not ready".
 */
export function useReplicache(): AlfredReplicache | null {
  return use(ReplicacheContext).rep;
}

export function useReplicacheStatus(): ReplicacheContextValue {
  return use(ReplicacheContext);
}
