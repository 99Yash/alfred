import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import { authClient } from "~/lib/auth/auth-client";
import type { AlfredReplicache } from "./client";

interface ReplicacheContextValue {
  rep: AlfredReplicache | null;
  loadError: string | null;
  pullError: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

const ReplicacheContext = createContext<ReplicacheContextValue>({
  rep: null,
  loadError: null,
  pullError: null,
  initialPullPending: true,
  retry: () => {},
});

/**
 * Shown across every synced surface when the data path starts 401ing — the
 * session cookie expired while the tab stayed open. Without this, pull/push
 * retry forever and the UI silently serves stale data with no signal.
 */
const SESSION_EXPIRED_MESSAGE = "Your session expired. Please sign in again.";

function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? `Sync failed: ${error.message}` : "Sync failed.";
}

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [rep, setRep] = useState<AlfredReplicache | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [initialPullPending, setInitialPullPending] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => {
    setPullError(null);
    if (rep) {
      void rep
        .pull({ now: true })
        .then(() => {
          setInitialPullPending(false);
          setPullError(null);
        })
        .catch((error: unknown) => {
          setPullError((current) => current ?? syncErrorMessage(error));
        });
      return;
    }
    setRetryNonce((nonce) => nonce + 1);
  }, [rep]);
  const contextValue = useMemo<ReplicacheContextValue>(
    () => ({ rep, loadError, pullError, initialPullPending, retry }),
    [initialPullPending, loadError, pullError, rep, retry],
  );

  useEffect(() => {
    if (!userId) {
      setRep(null);
      setLoadError(null);
      setPullError(null);
      setInitialPullPending(true);
      return;
    }
    let cancelled = false;
    let close: (() => void) | undefined;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveRetry: (() => void) | undefined;

    // Set once on the first 401 — Replicache retries the pull/push forever, so
    // onAuthError fires repeatedly; collapse that to a single state update.
    const handleAuthError = () => {
      if (cancelled) return;
      setLoadError((prev) => prev ?? SESSION_EXPIRED_MESSAGE);
    };

    const MAX_ATTEMPTS = 3;
    const waitForRetry = (ms: number) =>
      new Promise<void>((resolve) => {
        resolveRetry = resolve;
        retryTimeout = setTimeout(() => {
          retryTimeout = undefined;
          resolveRetry = undefined;
          resolve();
        }, ms);
      });

    const load = async () => {
      setLoadError(null);
      setPullError(null);
      setInitialPullPending(true);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          const { createReplicache } = await import("./client");
          if (cancelled) return;
          const instance = createReplicache(userId, {
            onAuthError: handleAuthError,
            onPullSuccess: () => {
              if (cancelled) return;
              setPullError(null);
            },
            onPullError: (message) => {
              if (cancelled) return;
              setPullError(message);
            },
          });
          close = instance.close;
          setRep(instance.rep);
          void instance.rep
            .pull({ now: true })
            .then(() => {
              if (cancelled) return;
              setInitialPullPending(false);
              setPullError(null);
            })
            .catch((error: unknown) => {
              if (cancelled) return;
              setPullError((current) => current ?? syncErrorMessage(error));
            });
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
          await waitForRetry(500 * attempt);
        }
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = undefined;
      const resolve = resolveRetry;
      resolveRetry = undefined;
      resolve?.();
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
