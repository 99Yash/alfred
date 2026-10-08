import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";

/**
 * The composer's Stop flag, in Redis. Not `cancelRun`: a stop keeps the streamed
 * text and ends the run `completed`.
 *
 * Two connections, split by caller (#127). The write and the one-shot read get no
 * second try, so they use `"command"`, which waits for `ready`. The stream-loop poll
 * uses `"fail-fast"`: a `"command"` read would stall each chunk up to 2s in an
 * outage, and a missed poll is fixed 400ms later.
 */

let boundedConn: BoundedRedis | null = null;

/** Waits for `ready`: every caller on this handle gets one read and no retry. */
function boundedRedis(): BoundedRedis {
  if (!boundedConn) boundedConn = createRedisConnection("command");

  return boundedConn;
}

let pollConn: BoundedRedis | null = null;

/** Never waits, because the stream loop awaits this read on every chunk. */
function pollRedis(): BoundedRedis {
  if (!pollConn) pollConn = createRedisConnection("fail-fast");

  return pollConn;
}

const stopKey = (runId: string) => `chat:stop:${runId}`;

/** Outlives any plausible turn; an orphaned flag for a finished run is inert. */
const STOP_TTL_SECONDS = 15 * 60;

/** Record a stop request. Returns false when Redis is unreachable. */
export async function requestChatStop(runId: string): Promise<boolean> {
  try {
    await boundedRedis().set(stopKey(runId), "1", "EX", STOP_TTL_SECONDS);

    return true;
  } catch {
    return false;
  }
}

/**
 * Read the flag once, for a caller with no retry. A wrong `false` sends a whole
 * tool batch after Stop, so this waits for the connection. Repeated reads use {@link pollChatStopFlag}.
 */
export async function isChatStopRequested(runId: string): Promise<boolean> {
  try {
    return (await boundedRedis().get(stopKey(runId))) !== null;
  } catch {
    return false;
  }
}

/**
 * Read the flag from the stream loop, where a slow read is worse than a missed one.
 * A cold connection returns false at once. One-shot reads use {@link isChatStopRequested}.
 */
export async function pollChatStopFlag(runId: string): Promise<boolean> {
  try {
    return (await pollRedis().get(stopKey(runId))) !== null;
  } catch {
    return false;
  }
}
