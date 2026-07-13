import { z } from "zod";

const boundedText = z.string().trim().min(1).max(8_000);

export const conversationSummarySourceSchema = z
  .object({
    kind: z.enum(["message", "tool", "attachment"]),
    id: z.string().min(1).max(256),
  })
  .strict();

const sourcedItemSchema = z
  .object({
    text: boundedText,
    sources: z.array(conversationSummarySourceSchema).min(1).max(20),
  })
  .strict();

const actionOutcomeSchema = sourcedItemSchema
  .extend({
    status: z.enum(["completed", "rejected", "failed", "unfinished"]),
  })
  .strict();

const importantEntitySchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    context: boundedText,
    sources: z.array(conversationSummarySourceSchema).min(1).max(20),
  })
  .strict();

export const conversationSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    overview: z
      .object({
        text: boundedText,
        sourceMessageRange: z
          .object({ fromMessageId: z.string().min(1), toMessageId: z.string().min(1) })
          .strict(),
      })
      .strict(),
    facts: z.array(sourcedItemSchema).max(100),
    preferences: z.array(sourcedItemSchema).max(100),
    instructions: z.array(sourcedItemSchema).max(100),
    decisions: z.array(sourcedItemSchema).max(100),
    actionOutcomes: z.array(actionOutcomeSchema).max(100),
    unresolvedQuestions: z.array(sourcedItemSchema).max(100),
    importantEntities: z.array(importantEntitySchema).max(100),
  })
  .strict();

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationSummarySource = z.infer<typeof conversationSummarySourceSchema>;

export interface EligibleConversationSummarySources {
  messageIds: ReadonlySet<string>;
  toolIds: ReadonlySet<string>;
  attachmentIds: ReadonlySet<string>;
}

export function parsePersistedConversationSummary(value: unknown): {
  summary: ConversationSummary | null;
  invalid: boolean;
} {
  if (value === null) return { summary: null, invalid: false };
  const parsed = conversationSummarySchema.safeParse(value);
  return parsed.success
    ? { summary: parsed.data, invalid: false }
    : { summary: null, invalid: true };
}

/**
 * Validate both model-output structure and provenance against the exact source
 * records eligible for this compaction generation.
 */
export function validateConversationSummary(
  value: unknown,
  eligible: EligibleConversationSummarySources,
): ConversationSummary {
  const summary = conversationSummarySchema.parse(value);
  const { fromMessageId, toMessageId } = summary.overview.sourceMessageRange;
  if (!eligible.messageIds.has(fromMessageId) || !eligible.messageIds.has(toMessageId)) {
    throw new Error("conversation_summary_invalid_provenance: overview range");
  }

  for (const source of conversationSummarySources(summary)) {
    const eligibleIds = eligibleIdsForSource(source, eligible);
    if (!eligibleIds.has(source.id)) {
      throw new Error(`conversation_summary_invalid_provenance: ${source.kind}:${source.id}`);
    }
  }
  return summary;
}

function eligibleIdsForSource(
  source: ConversationSummarySource,
  eligible: EligibleConversationSummarySources,
): ReadonlySet<string> {
  switch (source.kind) {
    case "message":
      return eligible.messageIds;
    case "tool":
      return eligible.toolIds;
    case "attachment":
      return eligible.attachmentIds;
    default:
      return assertNever(source.kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected conversation summary source kind: ${String(value)}`);
}

export function conversationSummarySources(
  summary: ConversationSummary,
): ConversationSummarySource[] {
  return [
    ...summary.facts,
    ...summary.preferences,
    ...summary.instructions,
    ...summary.decisions,
    ...summary.actionOutcomes,
    ...summary.unresolvedQuestions,
    ...summary.importantEntities,
  ].flatMap((item) => item.sources);
}
