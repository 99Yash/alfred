import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { openEventStream } from "./stream";

/** Invalidate React Query caches when SSE events arrive. Mount once, in the app shell. */
export function useEventBridge(): void {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();

  useEffect(() => {
    const userId = session?.user?.id;

    if (!userId) return;

    // No `onError`: `EventStreamBanner` shows bus failures and the inbox also polls.
    const close = openEventStream({
      onFrame: (frame) => {
        switch (frame.kind) {
          case "inbox.updated":
            void queryClient.invalidateQueries({ queryKey: ["me", "inbox"] });
            break;
          default:
            break;
        }
      },
    });

    return close;
  }, [session?.user?.id, queryClient]);
}
