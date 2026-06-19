import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { openEventStream } from "./stream";

/**
 * Side-effect hook that opens an SSE connection on behalf of the React
 * Query cache and invalidates the relevant queries when events arrive.
 * Mount once at the app shell — additional consumers (`useInbox`, etc.)
 * just read from React Query as usual.
 *
 * `openEventStream` multiplexes subscribers onto one shared EventSource, so
 * mounting this beside chat/debug listeners does not spend another browser SSE
 * connection slot.
 *
 * Current bindings:
 *   - `inbox.updated` → invalidate `["me","inbox"]` so the rail re-fetches.
 *
 * Adding a new binding: append a case in the switch. The hook does no
 * payload-level reasoning; that's by design — the wire payloads are
 * intentionally minimal (just enough to identify which query to
 * invalidate). Per-row diffs would buy us nothing the rail can use given
 * how few rows it shows.
 */
export function useEventBridge(): void {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    const close = openEventStream({
      onFrame: (frame) => {
        switch (frame.kind) {
          case "inbox.updated":
            void queryClient.invalidateQueries({ queryKey: ["me", "inbox"] });
            break;
          default:
            // Other kinds (agent.run, tool.call, approval.requested, …)
            // are consumed by their own subscribers via `useEventStream`
            // — no global cache-invalidation binding yet.
            break;
        }
      },
    });
    return close;
  }, [userId, queryClient]);
}
