import { Replicache } from "replicache";
import { summarizeBody } from "@alfred/contracts";
import type { ClientMutators } from "@alfred/sync";
import { clientMutators } from "@alfred/sync";

/**
 * Abort a pull/push that hasn't resolved in this window. Without it a
 * black-holed server (TCP accepted, never responds) leaves the fetch promise
 * pending forever and Replicache never retries — the sync silently wedges. A
 * thrown timeout is just another failed attempt Replicache backs off and
 * retries, which is exactly what we want.
 */
const SYNC_FETCH_TIMEOUT_MS = 30_000;

/**
 * Replicache partitions its IndexedDB by `(name, schemaVersion)`. Bumping this
 * constant makes every client treat its persisted store as a different DB —
 * the old one is abandoned and the next load cold-syncs from scratch.
 *
 * This is the canonical self-healing reset (the pattern dimension uses):
 *   - Bump it whenever a synced entity's *serialized shape* changes, so stale
 *     shapes in old IndexedDB stores can't silently linger and diverge.
 *   - Bump it as the recovery lever if a client ever wedges its local store
 *     (e.g. the #337 client-group fork) — a redeploy heals every client with
 *     no "clear your IndexedDB" handholding.
 *
 * Keep it a hand-bumped string (not derived) so the reset is an explicit,
 * code-reviewed decision tied to a deploy.
 */
const REPLICACHE_SCHEMA_VERSION = "1";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export type AlfredReplicache = Replicache<ClientMutators>;

/**
 * A Replicache handle paired with the last value read for it. The subscription
 * hooks (`use-briefings`, `use-workflows`, `use-chat`) store this so a client
 * swap and its stale snapshot are discarded together.
 */
export interface ReplicacheSnapshot<T> {
  rep: AlfredReplicache;
  value: T;
}

export interface CreateReplicacheOptions {
  /**
   * Fired when the synced data path looks unauthenticated — a pull/push that
   * 401s, or a poke `EventSource` that errors into a permanently CLOSED state
   * (a 401 closes it with no auto-reconnect). Lets the caller surface a
   * "session expired" state instead of an invisible infinite retry loop.
   */
  onAuthError?: () => void;
}

// Replicache surfaces a non-200 `errorMessage` via its logging /
// onClientStateNotFound paths; a blank string throws away the only diagnostic
// we get. Read the body (bounded) so a 401/5xx says *why* it failed.
async function describeFailure(response: Response): Promise<string> {
  let body = "";
  try {
    body = summarizeBody(await response.text());
  } catch {
    // Body already consumed or unreadable — fall back to the status line.
  }
  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

export function createReplicache(
  userId: string,
  options: CreateReplicacheOptions = {},
): {
  rep: AlfredReplicache;
  close: () => void;
} {
  // One place for "this pull/push failed": a 401 means the session cookie
  // expired (notify the caller), and a bounded body makes any failure
  // diagnosable instead of a blank errorMessage. Keeps puller/pusher in step.
  const failureInfo = async (response: Response) => {
    if (response.status === 401) options.onAuthError?.();
    return { httpStatusCode: response.status, errorMessage: await describeFailure(response) };
  };

  const rep = new Replicache<ClientMutators>({
    name: `alfred-${userId}`,
    schemaVersion: REPLICACHE_SCHEMA_VERSION,
    mutators: clientMutators,

    puller: async (req) => {
      const response = await fetch(`${API_URL}/api/replicache/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        credentials: "include",
        signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        return {
          response: await response.json(),
          httpRequestInfo: { httpStatusCode: response.status, errorMessage: "" },
        };
      }
      return { httpRequestInfo: await failureInfo(response) };
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

  // Subscribe to SSE pokes so Replicache pulls immediately on server writes.
  const source = new EventSource(`${API_URL}/api/replicache/events`, {
    withCredentials: true,
  });
  source.addEventListener("poke", () => {
    rep.pull();
  });
  source.onerror = () => {
    // A transient drop leaves the source CONNECTING (it auto-reconnects) — stay
    // quiet. A 401 closes it permanently (readyState CLOSED, no reconnect); that
    // mirrors an expired session, so surface it rather than silently dying.
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
