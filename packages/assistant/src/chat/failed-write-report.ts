import { meteredGenerateObject, route } from "@alfred/ai";
import { collapseWhitespace, humanizeToolName } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { z } from "zod";
import type { ToolCallLogEntry } from "./chat-turn-state";

/**
 * How a finished reply treats the writes that failed this turn. The honesty guard (#346)
 * keeps the reply unless it claims a failed write succeeded.
 * - `claims_success`: it says a failed write happened. Replace it.
 * - `reports_failure`: it already tells the user each write did not happen. Keep it as is.
 * - `silent`: it does not mention them. Keep it and append `note`.
 */
const failedWriteVerdictSchema = z.object({
  verdict: z.enum(["claims_success", "reports_failure", "silent"]),
  // Loose on purpose: the guard falls back to its own sentence when this is empty.
  note: z.string(),
});

export type FailedWriteVerdict = z.infer<typeof failedWriteVerdictSchema>;

/**
 * A write that failed this turn. `effectUnconfirmed`: the action record says the target may hold
 * its effect (`leavesEffectUnconfirmed`), so no reader may say that nothing changed.
 */
export type FailedWrite = ToolCallLogEntry & { readonly effectUnconfirmed?: true };

const JUDGE_TIMEOUT_MS = 10_000;

/** The verdict plus one or two short sentences. */
const JUDGE_MAX_OUTPUT_TOKENS = 200;

/** Enough for the opening summary of a long report. */
const REPLY_HEAD_CHARS = 6_000;

/** Enough for a closing "Done." line, where a success claim usually sits. */
const REPLY_TAIL_CHARS = 2_000;

/** A tool's input and error each fit in one line. More adds tokens, not evidence. */
const PREVIEW_CHARS = 300;

const JUDGE_SYSTEM_PROMPT = [
  "You check one assistant reply against a list of actions that failed during the same turn.",
  "Each failed action did NOT happen, except an action marked 'effect: unconfirmed'. That action may have happened, and nothing confirmed it.",
  "Decide how the reply treats them, as a whole:",
  "- claims_success: the reply states that at least one failed action was done (for example 'I've archived it', 'Sent.', 'Created the event').",
  "- reports_failure: the reply makes no such claim, and it tells the user that every failed action did not happen or could not be done, or for an unconfirmed action, that it is not confirmed.",
  "- silent: the reply makes no such claim, and it does not tell the user about at least one failed action.",
  "A reply that reports other work (findings, summaries, answers) and never mentions a failed action is silent.",
  "If unsure between claims_success and silent, choose silent.",
  "For silent only, write note: one or two short sentences that the assistant appends to its reply.",
  "The note tells the user, in plain words, which action it could not complete and the best next step.",
  "If the reply implies a failed action was done, the note says plainly that it was not done.",
  "For an unconfirmed action, the note never says that it did not happen or that nothing changed. It says that it may have gone through and that the user should check it before trying again.",
  "No tool names, no error codes, no apology, no dashes. For other verdicts, note is an empty string.",
].join("\n");

function preview(text: string | undefined): string {
  const flat = collapseWhitespace(text ?? "");

  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

function replyExcerpt(reply: string): string {
  if (reply.length <= REPLY_HEAD_CHARS + REPLY_TAIL_CHARS) return reply;

  return `${reply.slice(0, REPLY_HEAD_CHARS)}\n[…]\n${reply.slice(-REPLY_TAIL_CHARS)}`;
}

/**
 * Ask the cheap model how the reply treats the failed writes, and for a silent reply,
 * the note to append. Returns `null` on any failure; the guard then appends its own note.
 */
export async function judgeFailedWriteReport(args: {
  userId: string;
  runId: string;
  threadId: string;
  reply: string;
  failed: readonly FailedWrite[];
}): Promise<FailedWriteVerdict | null> {
  const actions = args.failed
    .map((call) => {
      const lines = [`- ${humanizeToolName(call.toolName)}`];

      if (call.effectUnconfirmed) lines.push("  effect: unconfirmed");
      const input = preview(call.argsPreview);
      const error = preview(call.resultPreview);

      if (input) lines.push(`  input: ${input}`);

      if (error) lines.push(`  error: ${error}`);

      return lines.join("\n");
    })
    .join("\n");

  try {
    const result = await meteredGenerateObject(
      {
        model: route("cheap").model(),
        schema: failedWriteVerdictSchema,
        schemaName: "failed_write_verdict",
        instructions: JUDGE_SYSTEM_PROMPT,
        prompt: `Failed actions:\n${actions}\n\nReply:\n${replyExcerpt(args.reply)}`,
        temperature: 0,
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
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

    return result.output;
  } catch (err) {
    logger.warn({ err, runId: args.runId }, "[chat-turn] failed-write report check failed");

    return null;
  }
}
