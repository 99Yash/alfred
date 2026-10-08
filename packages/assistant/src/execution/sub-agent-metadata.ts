import { getPath } from "@alfred/contracts";
import { agentRuns } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { subAgentIdSchema } from "@alfred/assistant/tool-runtime";

/**
 * Every sub-agent runs this workflow; it starts from a bare brief. A leaf module, to avoid an
 * import cycle.
 */
export const SUB_AGENT_WORKFLOW_SLUG = "__user-authored-brief__";

/**
 * The parent's chat turn, where the child streams its tool cards. `messageId` stays stable across
 * parks.
 */
const subAgentChatOriginSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
  })
  .strict();

export type SubAgentChatOrigin = z.infer<typeof subAgentChatOriginSchema>;

export const subAgentMetadataSchema = z
  .object({
    kind: z.literal("sub_agent"),
    parentRunId: z.string().min(1),
    subId: subAgentIdSchema,
    parentToolCallId: z.string().min(1),
    // Absent for a non-chat parent; the child then runs silently.
    chat: subAgentChatOriginSchema.optional(),
  })
  .strict();

export type SubAgentMetadata = z.infer<typeof subAgentMetadataSchema>;

export function readSubAgentMetadata(metadata: unknown): SubAgentMetadata | null {
  const parsed = subAgentMetadataSchema.safeParse(getPath(metadata, "subAgent"));

  return parsed.success ? parsed.data : null;
}

/** The runs whose parent is `parentRunId`. Add a `user_id` filter too: the index needs it. */
export function subAgentParentRunIdMatches(parentRunId: string) {
  return sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${parentRunId}`;
}

/** Keyed by child, so a boss waiting on several wakes only for the one that finished (ADR-0073). */
export function subAgentDoneSignalName(childRunId: string): string {
  return `sub_agent_done:${childRunId}`;
}
