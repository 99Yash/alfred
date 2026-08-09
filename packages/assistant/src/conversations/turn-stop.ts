import { Errors } from "@alfred/contracts";
import { getRun } from "@alfred/assistant/execution";
import { CHAT_TURN_WORKFLOW_SLUG } from "./chat-turn";
import { requestChatStop } from "./stop-signal";

export async function stopTurn(runId: string, userId: string): Promise<{ ok: true }> {
  const run = await getRun(runId, userId);
  if (!run) throw Errors.NotFoundError("Run not found");
  if (run.workflowSlug !== CHAT_TURN_WORKFLOW_SLUG) {
    throw Errors.BadRequestError("Not a chat run");
  }
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw Errors.ConflictError("Run already finished");
  }
  if (run.status === "waiting") {
    throw Errors.ConflictError("Run is awaiting approval — resolve the approval instead");
  }
  const recorded = await requestChatStop(runId);
  if (!recorded)
    throw Errors.ServiceUnavailableError("Couldn't reach the stop channel — try again");
  return { ok: true };
}

export interface ExistingChatTurnRun {
  runId: string | null;
  assistantMessageId: string;
}
