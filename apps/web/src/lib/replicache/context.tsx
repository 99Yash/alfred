import { assertNever } from "@alfred/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useReducer } from "react";
import type { Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { authClient } from "~/lib/auth/auth-client";

interface ReplicacheContextValue {
  rep: Replicache<ClientMutators> | null;
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

/** Pull and push retry a 401 forever, so without this the UI serves stale data silently. */
const SESSION_EXPIRED_MESSAGE = "Your session expired. Please sign in again.";

interface SyncLifecycle {
  rep: Replicache<ClientMutators> | null;
  loadError: string | null;
  pullError: string | null;
  initialPullPending: boolean;
  retryNonce: number;
  lifecycle: object | null;
}

type SyncLifecycleAction =
  | { type: "start"; lifecycle: object }
  | { type: "stop"; lifecycle: object }
  | { type: "signedOut" }
  | { type: "ready"; lifecycle: object; rep: Replicache<ClientMutators> }
  | { type: "authError"; lifecycle: object }
  | { type: "pullRecovered"; lifecycle: object }
  | { type: "pullReportedError"; lifecycle: object; message: string }
  | { type: "pullSucceeded"; lifecycle: object; rep: Replicache<ClientMutators> }
  | { type: "loadFailed"; lifecycle: object; message: string }
  | { type: "retryPull"; rep: Replicache<ClientMutators> }
  | { type: "retryLoad" };

const initialSyncLifecycle: SyncLifecycle = {
  rep: null,
  loadError: null,
  pullError: null,
  initialPullPending: true,
  retryNonce: 0,
  lifecycle: null,
};

function syncLifecycleReducer(state: SyncLifecycle, action: SyncLifecycleAction): SyncLifecycle {
  switch (action.type) {
    case "start":
      return {
        ...state,
        rep: null,
        loadError: null,
        pullError: null,
        initialPullPending: true,
        lifecycle: action.lifecycle,
      };
    case "stop":
      return state.lifecycle === action.lifecycle
        ? { ...initialSyncLifecycle, retryNonce: state.retryNonce }
        : state;
    case "signedOut":
      return { ...initialSyncLifecycle, retryNonce: state.retryNonce };
    case "ready":
      return state.lifecycle === action.lifecycle ? { ...state, rep: action.rep } : state;
    case "authError":
      return state.lifecycle === action.lifecycle
        ? { ...state, loadError: state.loadError ?? SESSION_EXPIRED_MESSAGE }
        : state;
    case "pullRecovered":
      return state.lifecycle === action.lifecycle ? { ...state, pullError: null } : state;
    case "pullReportedError":
      return state.lifecycle === action.lifecycle ? { ...state, pullError: action.message } : state;
    case "pullSucceeded":
      return state.lifecycle === action.lifecycle && state.rep === action.rep
        ? { ...state, pullError: null, initialPullPending: false }
        : state;
    case "loadFailed":
      return state.lifecycle === action.lifecycle
        ? { ...state, loadError: state.loadError ?? action.message }
        : state;
    case "retryPull":
      return state.rep === action.rep ? { ...state, pullError: null } : state;
    case "retryLoad":
      return { ...state, pullError: null, retryNonce: state.retryNonce + 1 };
    default:
      return assertNever(action, "sync lifecycle action");
  }
}

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const [sync, dispatch] = useReducer(syncLifecycleReducer, initialSyncLifecycle);
  const { rep, loadError, pullError, initialPullPending, retryNonce } = sync;

  const retry = useCallback(() => {
    if (rep) {
      dispatch({ type: "retryPull", rep });
      // The puller callbacks report this pull's outcome. While the initial pull is pending, the
      // initial-pull waiter (`awaitInitialPull`) resolves on this same attempt, and it re-arms if
      // the attempt fails.
      // This pull rejects only with "Closed" after the client closes, when the lifecycle is already over.
      void rep.pull({ now: true }).catch(() => undefined);

      return;
    }

    dispatch({ type: "retryLoad" });
  }, [rep]);

  const contextValue = useMemo<ReplicacheContextValue>(
    () => ({ rep, loadError, pullError, initialPullPending, retry }),
    [initialPullPending, loadError, pullError, rep, retry],
  );

  useEffect(() => {
    if (!userId) {
      dispatch({ type: "signedOut" });

      return;
    }

    const lifecycle = {};
    let cancelled = false;
    // Outcome of the latest puller call of this lifecycle's client.
    let lastPullSucceeded = false;
    let close: (() => void) | undefined;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveRetry: (() => void) | undefined;

    dispatch({ type: "start", lifecycle });

    // Fires on every retried 401; the reducer keeps the first message.
    const handleAuthError = () => {
      if (cancelled) return;
      dispatch({ type: "authError", lifecycle });
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

    // A call, not a bare read: TypeScript keeps a `let` narrowed across `await`,
    // so `cancelled` read after the loop guard types as `false` though cleanup sets it.
    const isCancelled = () => cancelled;

    const load = async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !isCancelled(); attempt++) {
        try {
          const { createReplicache } = await import("./client");

          if (isCancelled()) return;

          const instance = createReplicache(userId, {
            onAuthError: handleAuthError,
            onPullSuccess: () => {
              lastPullSucceeded = true;

              if (cancelled) return;
              dispatch({ type: "pullRecovered", lifecycle });
            },
            onPullError: (message) => {
              lastPullSucceeded = false;

              if (cancelled) return;
              dispatch({ type: "pullReportedError", lifecycle, message });
            },
          });

          close = instance.close;
          dispatch({ type: "ready", lifecycle, rep: instance.rep });

          // In replicache@15.3.0 (pinned, ADR-0061) `pull()` resolves after the pull attempt
          // finishes, whether the puller call failed or succeeded; it rejects only with "Closed".
          // A successful attempt has applied its rows and fired subscriptions before it resolves.
          // So the initial-pull waiter ends only on a resolve after a successful puller call. After
          // a failed one, it re-arms with a `now: false` pull. That pull keeps Replicache's backoff.
          // While the tab is visible it adds no request: its signal merges with a pull that the
          // loop already has signaled. It also waits until the tab is visible, but the loop does
          // not. So if the tab hides and Replicache recovers in the background, the re-arm sends
          // one request when the tab shows, and pending ends when that request succeeds.
          // Re-check this if the Replicache version changes.
          const awaitInitialPull = (now: boolean) => {
            void instance.rep.pull({ now }).then(
              () => {
                if (cancelled) return;

                if (lastPullSucceeded) {
                  dispatch({ type: "pullSucceeded", lifecycle, rep: instance.rep });

                  return;
                }

                awaitInitialPull(false);
              },
              // Rejects only with "Closed" after the client closes, when the lifecycle is already over.
              () => undefined,
            );
          };

          awaitInitialPull(true);

          return;
        } catch (err) {
          if (isCancelled()) return;

          if (attempt === MAX_ATTEMPTS) {
            dispatch({
              type: "loadFailed",
              lifecycle,
              message:
                err instanceof Error
                  ? `Sync client failed to load: ${err.message}`
                  : "Sync client failed to load.",
            });

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
      dispatch({ type: "stop", lifecycle });
      close?.();
    };
  }, [userId, retryNonce]);

  return <ReplicacheContext.Provider value={contextValue}>{children}</ReplicacheContext.Provider>;
}

/** `null` before sign-in or while the client loads. Treat it as "not ready". */
export function useReplicache(): Replicache<ClientMutators> | null {
  return use(ReplicacheContext).rep;
}

export function useReplicacheStatus(): ReplicacheContextValue {
  return use(ReplicacheContext);
}
