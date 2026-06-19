import { useEffect, useState } from "react";
import { authClient } from "~/lib/auth/auth-client";
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
  const userId = session?.user?.id;
  const [frames, setFrames] = useState<EventStreamFrame[]>([]);

  // Reset frames when the user changes — using the "previous prop" pattern so
  // the reset happens during render, not in an effect. The conditional setter
  // only fires on the render that observes the change, so it won't loop.
  const [prevUserId, setPrevUserId] = useState<string | undefined>(userId);
  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setFrames([]);
  }

  useEffect(() => {
    if (!userId) return;
    const close = openEventStream({
      onFrame: (frame) => {
        setFrames((prev) => [frame, ...prev].slice(0, limit));
      },
    });
    return close;
  }, [userId, limit]);

  return frames;
}
