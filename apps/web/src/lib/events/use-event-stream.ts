import { useEffect, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { openEventStream, type EventStreamFrame } from "./stream";

/**
 * Subscribe to /api/events for the signed-in user. Returns the running list of
 * frames received this session (newest first), capped at `limit`.
 *
 * Connection lifecycle is keyed to `session.user.id`: signing out tears down
 * the stream; signing in opens a fresh one. Last-Event-ID handling on
 * reconnect is automatic via the browser's EventSource.
 */
export function useEventStream(limit = 50): EventStreamFrame[] {
  const { data: session } = authClient.useSession();
  const [frames, setFrames] = useState<EventStreamFrame[]>([]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      setFrames([]);
      return;
    }
    const close = openEventStream({
      onFrame: (frame) => {
        setFrames((prev) => [frame, ...prev].slice(0, limit));
      },
    });
    return close;
  }, [session?.user?.id, limit]);

  return frames;
}
