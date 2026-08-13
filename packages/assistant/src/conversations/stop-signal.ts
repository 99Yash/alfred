import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";

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
 * TWO CONNECTIONS, one per verb, because the two commands on this key want
 * OPPOSITE failures. That is the whole reason the pair below is not one handle.
 *
 * The write is one-shot and user-initiated, and its caller fails CLOSED:
 * `packages/http/src/conversations.ts` turns a `false` return into a 503. So the
 * write must WAIT for a connection that is still handshaking rather than be
 * rejected by it, or the first stop press of every process 503s against a
 * healthy Redis (#127). That is `"command"`.
 *
 * The poll fails OPEN by design — an unreadable flag means the turn keeps
 * streaming (annoying), where fail-closed would stop every turn (broken) — and
 * it runs inside the model stream loop, at most once per 400 ms
 * (`turn-stop-controller.ts`). During a real outage a `"command"` read would
 * hold the chunk loop for up to its 2 s bound on each poll, because
 * `stream-model-turn.ts` awaits `checkStop()`. A `"fail-fast"` read rejects at
 * once and the loop keeps streaming. Its cold-window miss costs one poll, which
 * the next poll 400 ms later corrects. That is `"fail-fast"`, and the extra
 * socket per process is the cheaper of the two costs.
 */

let writeConn: BoundedRedis | null = null;
/** The write half: waits for `ready`, because its caller fails closed. */
function writeRedis(): BoundedRedis {
  if (!writeConn) writeConn = createRedisConnection("command");
  return writeConn;
}

let pollConn: BoundedRedis | null = null;
/** The poll half: never waits, because the stream loop awaits this read. */
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
    await writeRedis().set(stopKey(runId), "1", "EX", STOP_TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

/** Poll the stop flag. Returns false (keep streaming) when Redis is unreachable. */
export async function isChatStopRequested(runId: string): Promise<boolean> {
  try {
    return (await pollRedis().get(stopKey(runId))) !== null;
  } catch {
    return false;
  }
}
