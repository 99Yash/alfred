import { Replicache, type PullerResultV1 } from "replicache";
import { summarizeBody } from "@alfred/contracts";
import type { ClientMutators } from "@alfred/sync";
import { clientMutators } from "@alfred/sync";
import { API_URL } from "~/lib/eden";
import { subscribeToBackForwardCache } from "~/lib/page-lifecycle";

/** A server that accepts TCP but never answers would wedge sync. A timeout becomes a normal retry. */
const SYNC_FETCH_TIMEOUT_MS = 30_000;

/**
 * Bump to abandon every client's IndexedDB and cold-sync on next load.
 * Bump when a synced entity's shape changes, or to heal a wedged local store.
 */
const REPLICACHE_SCHEMA_VERSION = "1";

export interface CreateReplicacheOptions {
  /** A pull or push got a 401, or the poke `EventSource` closed for good. */
  onAuthError?: (() => void) | undefined;
  onPullSuccess?: (() => void) | undefined;
  /** HTTP, network, timeout, and parse failures. */
  onPullError?: ((message: string) => void) | undefined;
}

// `errorMessage` is the only diagnostic Replicache logs, so include a bounded body.
async function describeFailure(response: Response): Promise<string> {
  let body = "";

  try {
    body = summarizeBody(await response.text());
  } catch {
    // Unreadable body: use the status line.
  }

  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

function describePullError(error: unknown): string {
  return error instanceof Error ? `Sync failed: ${error.message}` : "Sync failed.";
}

interface CreatedReplicache {
  rep: Replicache<ClientMutators>;
  close: () => void;
}

export function createReplicache(
  userId: string,
  options: CreateReplicacheOptions = {},
): CreatedReplicache {
  const failureInfo = async (response: Response) => {
    if (response.status === 401) options.onAuthError?.();

    return { httpStatusCode: response.status, errorMessage: await describeFailure(response) };
  };

  const rep = new Replicache<ClientMutators>({
    name: `alfred-${userId}`,
    schemaVersion: REPLICACHE_SCHEMA_VERSION,
    mutators: clientMutators,

    puller: async (req) => {
      try {
        const response = await fetch(`${API_URL}/api/replicache/pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
          credentials: "include",
          signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
        });

        if (response.ok) {
          const pulled: PullerResultV1 = {
            // oxlint-disable-next-line typescript/no-unsafe-assignment -- Replicache owns the pull-response contract: it asserts every puller result ("Invalid puller result") before it reads one, and PullerResultV1 has no `unknown` slot to hand the body over in.
            response: await response.json(),
            httpRequestInfo: { httpStatusCode: response.status, errorMessage: "" },
          };

          options.onPullSuccess?.();

          return pulled;
        }

        const httpRequestInfo = await failureInfo(response);
        options.onPullError?.(`Sync failed: ${httpRequestInfo.errorMessage}`);

        return { httpRequestInfo };
      } catch (error) {
        options.onPullError?.(describePullError(error));
        throw error;
      }
    },

    pusher: async (req) => {
      const response = await fetch(`${API_URL}/api/replicache/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        credentials: "include",
        signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
      });

      if (response.ok) {
        return { httpRequestInfo: { httpStatusCode: response.status, errorMessage: "" } };
      }

      return { httpRequestInfo: await failureInfo(response) };
    },
  });

  let source: EventSource | null = null;

  // Pull at once when the server pokes.
  const openPokes = () => {
    const next = new EventSource(`${API_URL}/api/replicache/events`, {
      withCredentials: true,
    });

    next.addEventListener("poke", () => {
      void rep.pull();
    });
    next.onerror = () => {
      // A transient drop stays CONNECTING and retries. CLOSED means a 401.
      if (next.readyState === EventSource.CLOSED) options.onAuthError?.();
    };

    source = next;
  };

  const closePokes = () => {
    source?.close();
    source = null;
  };

  openPokes();

  // A page in the back/forward cache must not hold a connection (see `subscribeToBackForwardCache`).
  // On restore, pull once: a poke sent while the page was cached is lost.
  const stopPageLifecycle = subscribeToBackForwardCache({
    onEnter: closePokes,
    onRestore: () => {
      if (source) return;
      openPokes();
      void rep.pull();
    },
  });

  return {
    rep,
    close: () => {
      stopPageLifecycle();
      closePokes();
      void rep.close();
    },
  };
}
