import { getPath } from "@alfred/contracts";
import { z } from "zod";

/**
 * The workflow every sub-agent run executes, regardless of which workflow
 * spawned it. The user-authored-brief workflow is the one that's sub-agent
 * aware (its `initialState` branches on `subAgent` metadata for the focused
 * prompt / model / restricted tools), and it runs from a bare brief — so it
 * works even when the parent's own workflow is thread-coupled and can't
 * (e.g. chat-turn, which requires a `threadId`). Lives in this leaf module so
 * `sub-agents.ts` can reference it without importing the workflow (which would
 * cycle through the tool registry).
 */
export const SUB_AGENT_WORKFLOW_SLUG = "__user-authored-brief__";

export const subAgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "subId may only contain letters, numbers, underscores, and dashes");

export const subAgentMetadataSchema = z
  .object({
    kind: z.literal("sub_agent"),
    parentRunId: z.string().min(1),
    subId: subAgentIdSchema,
    parentToolCallId: z.string().min(1),
  })
  .strict();

export type SubAgentMetadata = z.infer<typeof subAgentMetadataSchema>;

export function readSubAgentMetadata(metadata: unknown): SubAgentMetadata | null {
  const parsed = subAgentMetadataSchema.safeParse(getPath(metadata, "subAgent"));
  return parsed.success ? parsed.data : null;
}

/**
 * The wake-condition signal a sub-agent fires (via the executor's terminal
 * commit) so its waiting parent flips back to `runnable`. ADR-0073: keyed by
 * the child's run id, so a boss awaiting several children wakes only for the
 * one that finished. Both the `await_sub_agent` park and the terminal-signal
 * site derive the name from here — one definition, no string drift.
 */
export function subAgentDoneSignalName(childRunId: string): string {
  return `sub_agent_done:${childRunId}`;
}
