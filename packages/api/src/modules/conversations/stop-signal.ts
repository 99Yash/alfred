import type IORedis from "ioredis";
import { createCacheRedisConnection } from "../../queue/connection";

/**
 * User-initiated stop for an in-flight chat turn — what the composer's stop
 * button calls. (The approvals panel's "cancel run" decision is a different
 * thing entirely: it goes through `cancelRun` and ends the run `cancelled`.)
 *
 * The flag lives in Redis, shared by the API process that takes the stop request
 * and the worker draining the model stream, rather than in the agent harness's
 * status machine — but note WHY, because the original reason is gone. It used to
 * be that a mid-step `cancelled` was unsafe: `commitStepSuccess` wrote run status
 * unconditionally at step boundaries, so the flip was silently overwritten when
 * the step committed. #530 closed that; a mid-step terminal status now survives.
 *
 * What still argues for the side-channel is the product semantics. A stop is not
 * an abort: the chat-turn step notices the flag on its own schedule, finalizes
 * the partial assistant message through the normal path, and ends the run
 * `completed`, so the text the user already read stays and the turn reads as
 * finished rather than cancelled. Going through `cancelRun` instead would discard
 * the in-flight step's work and mark the run terminal from the outside.
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
