import { meteredGenerateObject, route } from "@alfred/ai";
import { humanizeToolName } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { z } from "zod";
import type { ChatRunState } from "./chat-turn-state";

/**
 * How a finished reply treats the writes that failed this turn. The honesty guard (#346)
 * keeps the reply unless it claims a failed write succeeded.
 * - `claims_success`: it says or implies a failed write happened. Replace it.
 * - `reports_failure`: it already tells the user each write did not happen. Keep it as is.
 * - `silent`: it does not mention them. Keep it and add a short note.
 */
const failedWriteReportSchema = z.object({
  verdict: z.enum(["claims_success", "reports_failure", "silent"]),
});

export type FailedWriteReport = z.infer<typeof failedWriteReportSchema>["verdict"];

type ToolCallLogEntry = ChatRunState["toolCallsLog"][number];

const JUDGE_TIMEOUT_MS = 10_000;

/** Enough to see a closing "Done." on a long report, and the opening summary. */
const REPLY_HEAD_CHARS = 6_000;

const REPLY_TAIL_CHARS = 2_000;

const PREVIEW_CHARS = 300;

const JUDGE_SYSTEM_PROMPT = [
  "You check one assistant reply against a list of actions that failed during the same turn.",
  "Each failed action did NOT happen. Decide how the reply treats them, as a whole:",
  "- claims_success: the reply says or implies that at least one failed action was done (for example 'I've archived it', 'Sent.', 'Created the event').",
  "- reports_failure: the reply makes no such claim, and it tells the user that every failed action did not happen or could not be done.",
  "- silent: the reply makes no such claim, and it does not tell the user about at least one failed action.",
  "A reply that reports other work (findings, summaries, answers) and never mentions a failed action is silent, not claims_success.",
  "If unsure between claims_success and another verdict, choose claims_success.",
].join("\n");

function clip(text: string | undefined, max: number): string {
  if (!text) return "";

  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function replyExcerpt(reply: string): string {
  if (reply.length <= REPLY_HEAD_CHARS + REPLY_TAIL_CHARS) return reply;

  return `${reply.slice(0, REPLY_HEAD_CHARS)}\n[…]\n${reply.slice(-REPLY_TAIL_CHARS)}`;
}

/**
 * Ask the cheap model how the reply treats the failed writes. Never throws: on any
 * failure it returns `silent`, and the guard then keeps the reply and asks for a note
 * that must also correct a false claim.
 */
export async function judgeFailedWriteReport(args: {
  userId: string;
  runId: string;
  threadId: string;
  reply: string;
  failed: readonly ToolCallLogEntry[];
}): Promise<FailedWriteReport> {
  const actions = args.failed
    .map((call) => {
      const lines = [`- ${humanizeToolName(call.toolName)}`];
      const input = clip(call.argsPreview, PREVIEW_CHARS);
      const error = clip(call.resultPreview, PREVIEW_CHARS);

      if (input) lines.push(`  input: ${input}`);

      if (error) lines.push(`  error: ${error}`);

      return lines.join("\n");
    })
    .join("\n");

  try {
    const result = await meteredGenerateObject(
      {
        model: route("cheap").model(),
        schema: failedWriteReportSchema,
        schemaName: "failed_write_report",
        instructions: JUDGE_SYSTEM_PROMPT,
        prompt: `Failed actions:\n${actions}\n\nReply:\n${replyExcerpt(args.reply)}`,
        temperature: 0,
        maxOutputTokens: 50,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      },
      {
        kind: "llm",
        userId: args.userId,
        runId: args.runId,
        sessionId: args.threadId,
        name: "chat.failed-write-report",
      },
    );

    return result.output.verdict;
  } catch (err) {
    logger.warn({ err, runId: args.runId }, "[chat-turn] failed-write report check failed");

    return "silent";
  }
}
