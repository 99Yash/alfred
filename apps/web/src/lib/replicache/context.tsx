import { createContext, use, useCallback, useEffect, useMemo, useReducer } from "react";
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

interface SyncLifecycle {
  rep: AlfredReplicache | null;
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
  | { type: "ready"; lifecycle: object; rep: AlfredReplicache }
  | { type: "authError"; lifecycle: object }
  | { type: "pullRecovered"; lifecycle: object }
  | { type: "pullReportedError"; lifecycle: object; message: string }
  | { type: "pullSucceeded"; lifecycle: object; rep: AlfredReplicache }
  | { type: "pullFailed"; lifecycle: object; rep: AlfredReplicache; message: string }
  | { type: "loadFailed"; lifecycle: object; message: string }
  | { type: "retryPull"; rep: AlfredReplicache }
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
    case "pullFailed":
      return state.lifecycle === action.lifecycle && state.rep === action.rep
        ? { ...state, pullError: state.pullError ?? action.message }
        : state;
    case "loadFailed":
      return state.lifecycle === action.lifecycle
        ? { ...state, loadError: state.loadError ?? action.message }
        : state;
    case "retryPull":
      return state.rep === action.rep ? { ...state, pullError: null } : state;
    case "retryLoad":
      return { ...state, pullError: null, retryNonce: state.retryNonce + 1 };
  }
}

export function ReplicacheProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [sync, dispatch] = useReducer(syncLifecycleReducer, initialSyncLifecycle);
  const { rep, loadError, pullError, initialPullPending, retryNonce } = sync;
  const retry = useCallback(() => {
    if (rep) {
      const lifecycle = sync.lifecycle;
      if (!lifecycle) return;
      dispatch({ type: "retryPull", rep });
      void rep
        .pull({ now: true })
        .then(() => {
          dispatch({ type: "pullSucceeded", lifecycle, rep });
        })
        .catch((error: unknown) => {
          dispatch({
            type: "pullFailed",
            lifecycle,
            rep,
            message: syncErrorMessage(error),
          });
        });
      return;
    }
    dispatch({ type: "retryLoad" });
  }, [rep, sync.lifecycle]);
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
    let close: (() => void) | undefined;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveRetry: (() => void) | undefined;

    dispatch({ type: "start", lifecycle });

    // Set once on the first 401 — Replicache retries the pull/push forever, so
    // onAuthError fires repeatedly; collapse that to a single state update.
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

    const load = async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        try {
          const { createReplicache } = await import("./client");
          if (cancelled) return;
          const instance = createReplicache(userId, {
            onAuthError: handleAuthError,
            onPullSuccess: () => {
              if (cancelled) return;
              dispatch({ type: "pullRecovered", lifecycle });
            },
            onPullError: (message) => {
              if (cancelled) return;
              dispatch({ type: "pullReportedError", lifecycle, message });
            },
          });
          close = instance.close;
          dispatch({ type: "ready", lifecycle, rep: instance.rep });
          void instance.rep
            .pull({ now: true })
            .then(() => {
              if (cancelled) return;
              dispatch({ type: "pullSucceeded", lifecycle, rep: instance.rep });
            })
            .catch((error: unknown) => {
              if (cancelled) return;
              dispatch({
                type: "pullFailed",
                lifecycle,
                rep: instance.rep,
                message: syncErrorMessage(error),
              });
            });
          return;
        } catch (err) {
          if (cancelled) return;
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
