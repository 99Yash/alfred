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
 * TWO CONNECTIONS, one per FAILURE SHAPE — not one per verb. Three callers
 * share this key and only one of them may be rejected by a connection that is
 * still handshaking, so the split follows the CALLER, and a read sits on each
 * side of it.
 *
 * THE BOUNDED HANDLE carries `requestChatStop` and `isChatStopRequested`.
 * The write is one-shot and user-initiated, and its caller fails CLOSED:
 * `packages/http/src/conversations.ts` turns a `false` return into a 503. The
 * read is the dispatch-tools step's single up-front check (`chat-turn.ts`),
 * which has no retry by design — a rejection there dispatches the whole pending
 * tool batch, with its external effects, after the user asked to stop. Neither
 * caller can answer the question from another store, because this key IS the
 * flag, so both WAIT for a handshaking connection rather than be rejected by it
 * (#127). That is `"command"`, which waits for `ready` and still bounds the wait.
 *
 * THE FAIL-FAST HANDLE carries `pollChatStopFlag`, and no other caller may join
 * it. That poll fails OPEN by design — an unreadable flag means the turn keeps
 * streaming (annoying), where fail-closed would stop every turn (broken) — and
 * it runs inside the model stream loop, at most once per 400 ms
 * (`turn-stop-controller.ts`). During a real outage a `"command"` read would
 * hold the chunk loop for up to its 2 s bound on each poll, because
 * `stream-model-turn.ts` awaits `checkStop()`. A `"fail-fast"` read rejects at
 * once and the loop keeps streaming. Its cold-window miss costs one poll, which
 * the next poll 400 ms later corrects. The extra socket per process is the
 * cheaper of the two costs.
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
 * Read the stop flag ONCE, for a caller that gets no second chance. The
 * dispatch-tools step is the one such caller: it reads this before it dispatches
 * a pending tool batch, and a `false` it reads by mistake sends every external
 * effect in that batch after the user asked to stop. So this read waits for a
 * handshaking connection. Returns false (dispatch) only when Redis stays
 * unreachable for the whole `"command"` bound.
 *
 * A caller that reads the flag REPEATEDLY must use {@link pollChatStopFlag}.
 */
export async function isChatStopRequested(runId: string): Promise<boolean> {
  try {
    return (await boundedRedis().get(stopKey(runId))) !== null;
  } catch {
    return false;
  }
}

/**
 * Read the stop flag from the model stream loop, where a slow read is worse than
 * a missed one. Rejects instead of waiting, so a cold or unreachable connection
 * returns false (keep streaming) at once. The caller polls again 400 ms later
 * (`turn-stop-controller.ts`), which is what makes the miss free.
 *
 * A caller that reads the flag ONCE must use {@link isChatStopRequested}.
 */
export async function pollChatStopFlag(runId: string): Promise<boolean> {
  try {
    return (await pollRedis().get(stopKey(runId))) !== null;
  } catch {
    return false;
  }
}
