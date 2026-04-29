import { Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { clientMutators } from "@alfred/sync";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export type AlfredReplicache = Replicache<ClientMutators>;

export function createReplicache(userId: string): {
  rep: AlfredReplicache;
  close: () => void;
} {
  const rep = new Replicache<ClientMutators>({
    name: `alfred-${userId}`,
    mutators: clientMutators,

    puller: async (req) => {
      const response = await fetch(`${API_URL}/api/replicache/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        credentials: "include",
      });
      const httpRequestInfo = { httpStatusCode: response.status, errorMessage: "" };
      if (response.status === 200) {
        return { response: await response.json(), httpRequestInfo };
      }
      return { httpRequestInfo };
    },

    pusher: async (req) => {
      const response = await fetch(`${API_URL}/api/replicache/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        credentials: "include",
      });
      return { httpRequestInfo: { httpStatusCode: response.status, errorMessage: "" } };
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
    // SSE will auto-reconnect; silence the console noise.
  };

  return {
    rep,
    close: () => {
      source.close();
      void rep.close();
    },
  };
}
