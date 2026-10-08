import { Replicache } from "replicache";
import { summarizeBody } from "@alfred/contracts";
import type { ClientMutators } from "@alfred/sync";
import { clientMutators } from "@alfred/sync";
import { API_URL } from "~/lib/eden";

/** A server that accepts TCP but never answers would wedge sync. A timeout becomes a normal retry. */
const SYNC_FETCH_TIMEOUT_MS = 30_000;

/**
 * Bump to abandon every client's IndexedDB and cold-sync on next load.
 * Bump when a synced entity's shape changes, or to heal a wedged local store.
 */
const REPLICACHE_SCHEMA_VERSION = "1";

/** A handle with its last read value, so a client swap drops the stale value too. */
export interface ReplicacheSnapshot<T> {
  rep: Replicache<ClientMutators>;
  value: T;
}

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
          const body = await response.json();
          options.onPullSuccess?.();

          return {
            response: body,
            httpRequestInfo: { httpStatusCode: response.status, errorMessage: "" },
          };
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

  // Pull at once when the server pokes.
  const source = new EventSource(`${API_URL}/api/replicache/events`, {
    withCredentials: true,
  });

  source.addEventListener("poke", () => {
    rep.pull();
  });
  source.onerror = () => {
    // A transient drop stays CONNECTING and retries. CLOSED means a 401.
    if (source.readyState === EventSource.CLOSED) options.onAuthError?.();
  };

  return {
    rep,
    close: () => {
      source.close();
      void rep.close();
    },
  };
}
