import { isRecord, type IanaTimezone } from "@alfred/contracts";
import { messageTimeNote } from "@alfred/assistant/chat/turn-context";

/** What a grounding eval's task returns: the tool call the agent chose, or `null` and its text. */
export interface GroundingTaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}

/** The diagnostic view of a tool-call input: the object, or `null` when no call or no object came back. */
export function toolCallArgs(input: unknown): Record<string, unknown> | null {
  return isRecord(input) ? input : null;
}

/**
 * A user message as chat replays it: the text, then its saved time note when one is due (ADR-0130
 * decision 7, amendment (f)). `previousUserAt` is the time of the user's previous message, if any.
 */
export function userMessageAt(
  text: string,
  timezone: IanaTimezone,
  sentAt: Date,
  previousUserAt?: Date,
): string {
  const note = messageTimeNote({ timezone, sentAt, previousUserAt });

  return note === null ? text : `${text}\n\n${note}`;
}

/** The first user message of a thread as chat replays it. */
export function firstUserMessage(text: string, timezone: IanaTimezone, sentAt: Date): string {
  return userMessageAt(text, timezone, sentAt);
}
