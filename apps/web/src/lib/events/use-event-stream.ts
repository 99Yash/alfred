import { useEffect, useState } from "react";
import { authClient } from "~/lib/auth/auth-client";
import type { EventStreamFrame } from "./frame";
import { openEventStream } from "./stream";

/** Frames received this session for the signed-in user, newest first, capped at `limit`. */
export function useEventStream(limit = 50): EventStreamFrame[] {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [frames, setFrames] = useState<EventStreamFrame[]>([]);

  // Reset during render when the user changes, not in an effect.
  const [prevUserId, setPrevUserId] = useState<string | undefined>(userId);

  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setFrames([]);
  }

  useEffect(() => {
    if (!userId) return;

    // No `onError`: `EventStreamBanner` shows bus failures.
    const close = openEventStream({
      onFrame: (frame) => {
        setFrames((prev) => [frame, ...prev].slice(0, limit));
      },
    });

    return close;
  }, [session?.user?.id, limit]);

  return frames;
}
