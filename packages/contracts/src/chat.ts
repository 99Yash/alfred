import { z } from "zod";
import { INTEGRATION_SLUGS } from "./integrations";

/** The chat depth the user picks. `@alfred/ai`'s `route` maps each tier to a model. */
export const chatModelTierValues = ["standard", "deep"] as const;

export type ChatModelTier = (typeof chatModelTierValues)[number];

export const chatModelTierSchema = z.enum(chatModelTierValues);

/** The AI SDK `reasoning` levels, without `provider-default` (not a level). */
export const chatEffortValues = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ChatEffort = (typeof chatEffortValues)[number];

export const chatEffortSchema = z.enum(chatEffortValues);

/**
 * Why a chat turn failed. The server maps the raw error to a kind and never sends
 * the raw text, because it leaks vendor URLs.
 *   - `attachment`: an image in this turn is unreadable. Retry without it.
 *   - `attachment_history`: an image in an earlier turn is unreadable. The transcript
 *     replays it each turn, so only a new chat fixes it.
 *   - `budget_exhausted`: the model provider rejected the call for money (spend cap,
 *     usage limit, credit balance). A retry cannot succeed, so the client offers none.
 *   - `timeout`: the stream ceiling stopped the turn after one automatic retry.
 *   - `too_long`: over the context limit. The tool-loop cap lands the turn instead.
 */
export const chatErrorKindValues = [
  "attachment",
  "attachment_history",
  "budget_exhausted",
  "overloaded",
  "rate_limited",
  "timeout",
  "too_long",
  "generic",
] as const;

export type ChatErrorKind = (typeof chatErrorKindValues)[number];

export const chatErrorKindSchema = z.enum(chatErrorKindValues);

/**
 * The repair the chat offers when a tool call is refused for connection health.
 * A closed enum, so a persisted slug the registry dropped fails the parse on replay.
 * `reconnect` covers `needs_reauth` and `missing_scope`.
 */
export const chatConnectNudgeSchema = z.object({
  integration: z.enum(INTEGRATION_SLUGS),
  action: z.enum(["connect", "reconnect"]),
});

export type ChatConnectNudge = z.infer<typeof chatConnectNudgeSchema>;

/** One agent's share of a turn's spend. `subId` is `null` for the boss. */
export const chatMessageAgentUsageSchema = z.object({
  subId: z.string().nullable(),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export type ChatMessageAgentUsage = z.infer<typeof chatMessageAgentUsageSchema>;

/**
 * Usage and cost for one assistant turn, rolled up from `api_call_log` at finalize.
 * Totals include sub-agent runs, which carry most of the spend.
 */
export const chatMessageUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  /**
   * Input tokens written into the prompt cache. Billed above plain input, so a miss
   * costs more than no cache. `null` means not recorded, not zero.
   */
  cacheWriteInputTokens: z.number().int().nonnegative().nullable().default(null),
  /** Model time only (request to stream end), so `outputTokens / modelLatencyMs` is throughput. */
  modelLatencyMs: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
  /**
   * Models that served the turn, most-used first. `fallback` counts calls a
   * `withFallback` cascade degraded; `primary` is the model that failed, if recorded.
   * Read from metering rows, because the route table can change which model is primary.
   */
  models: z
    .array(
      z.object({
        model: z.string(),
        calls: z.number().int().positive(),
        fallback: z
          .object({ primary: z.string().nullable(), calls: z.number().int().positive() })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
  /** The effort the route asked for. A fallback leg may have run some calls lower. */
  effort: chatEffortSchema.default("medium"),
  /** Cost per agent, most expensive first. Empty means unknown, not zero. */
  agents: z.array(chatMessageAgentUsageSchema).default([]),
});

export type ChatMessageUsage = z.infer<typeof chatMessageUsageSchema>;

/**
 * Turn start response. `busy` is not an error: another message's run is in flight,
 * so the client keeps this one queued and retries after `runId` ends.
 * `started.runId` is `null` only when the run row could not be re-read after a race.
 */
export const turnStartResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("started"),
    runId: z.string().nullable(),
    assistantMessageId: z.string().min(1),
  }),
  z.object({
    outcome: z.literal("busy"),
    runId: z.string().nullable(),
  }),
]);

export type TurnStartResponse = z.infer<typeof turnStartResponseSchema>;

/** @deprecated Use `turnStartResponseSchema`. */
export const turnKickResponseSchema = turnStartResponseSchema;

/** @deprecated Use `TurnStartResponse`. */
export type TurnKickResponse = TurnStartResponse;

/** Most turns that may wait while a reply streams. */
export const MAX_QUEUED_TURNS = 10;

/** True when a turn has no text, files, retried attachments, or artifact target. */
export function isEmptyChatTurnInput(input: {
  content: string;
  hasFiles: boolean;
  artifactTargetId?: string | undefined;
  retryAttachmentIds?: string[] | undefined;
}): boolean {
  const hasText = input.content.trim().length > 0;
  const hasArtifact = Boolean(input.artifactTargetId);
  const hasRetry = Boolean(input.retryAttachmentIds && input.retryAttachmentIds.length > 0);

  return !hasText && !input.hasFiles && !hasArtifact && !hasRetry;
}
