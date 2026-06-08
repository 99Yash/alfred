import type IORedis from "ioredis";
import { createCacheRedisConnection } from "../../queue/connection";

/**
 * User-initiated stop for an in-flight chat turn.
 *
 * The flag lives in Redis (shared by the API process that takes the stop
 * request and the worker that's draining the model stream) rather than in the
 * agent harness's status machine: `commitStepSuccess` writes run status
 * unconditionally at step boundaries, so flipping `agent_runs.status` to
 * `cancelled` mid-step would be silently overwritten when the step commits.
 * A side-channel flag lets the chat-turn step notice the stop on its own
 * schedule, finalize the partial assistant message through the normal path,
 * and end the run as `completed` — no harness semantics touched.
 *
 * Fail-open on Redis trouble: a stop that can't be recorded means the turn
 * keeps streaming (annoying), whereas fail-closed would mean every turn stops
 * (broken). The cache-style connection rejects fast instead of queueing.
 */

let conn: IORedis | null = null;
function redis(): IORedis {
  if (!conn) conn = createCacheRedisConnection();
  return conn;
}

const stopKey = (runId: string) => `chat:stop:${runId}`;

/** Outlives any plausible turn; an orphaned flag for a finished run is inert. */
const STOP_TTL_SECONDS = 15 * 60;

/** Record a stop request. Returns false when Redis is unreachable. */
export async function requestChatStop(runId: string): Promise<boolean> {
  try {
    await redis().set(stopKey(runId), "1", "EX", STOP_TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

/** Poll the stop flag. Returns false (keep streaming) when Redis is unreachable. */
export async function isChatStopRequested(runId: string): Promise<boolean> {
  try {
    return (await redis().get(stopKey(runId))) !== null;
  } catch {
    return false;
  }
}
