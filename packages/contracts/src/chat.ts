import { z } from "zod";
import { INTEGRATION_SLUGS } from "./integrations";

/**
 * Chat model tier — the user-selectable depth for a chat turn. The single
 * source of truth for the tier literal, shared so the web bundle can reference
 * it without pulling in `@alfred/ai` (Node-only): the composer's tier picker
 * and the send-message hook both previously hand-declared the same literal.
 * `@alfred/ai`'s `route` maps each tier to a concrete model; see
 * `provider.ts`.
 *
 *   - `standard` — the default conversational driver (the fast everyday model).
 *   - `deep`     — escalation for hard, multi-step turns.
 */
export const chatModelTierValues = ["standard", "deep"] as const;
export type ChatModelTier = (typeof chatModelTierValues)[number];
export const chatModelTierSchema = z.enum(chatModelTierValues);

/**
 * Why a chat turn ended in `status:"failed"`. The server classifies the raw
 * provider/runtime error into one of these user-meaningful kinds (it never
 * surfaces the raw error — that leaks vendor URLs and attempt-count noise);
 * the client pattern-matches the kind to a tailored, leak-free message and the
 * right recovery affordance. This is the one source of truth for the literal,
 * shared by the DB column (`chat_messages.error_kind`), the synced schema, and
 * the web bubble. Borrows Effect's tagged-error → handle-per-tag shape in
 * plain TS (we deliberately don't depend on Effect).
 *
 *   - `attachment`    — the model couldn't read an image attached to the
 *                       *current* turn. Recoverable: drop it + retry ("Send
 *                       without it").
 *   - `attachment_history` — the model couldn't read an image from an *earlier*
 *                       turn that the whole-thread transcript replays every turn
 *                       (.lessons/chat-vision-transcript-replay-poison.md).
 *                       Dropping the current turn's attachments can't fix it —
 *                       the poison lives in history — so the only recovery is a
 *                       new chat. Distinct from `attachment` precisely so the UI
 *                       doesn't offer a dead-end "Send without it" retry.
 *   - `overloaded`    — a transient provider fault (5xx / "internal error" /
 *                       overloaded / network). Recoverable: retry.
 *   - `rate_limited`  — upstream throttling (429). Recoverable: wait + retry.
 *   - `timeout`       — the streaming circuit-breaker aborted the turn: it ran
 *                       past the total/chunk stream ceiling (most often the
 *                       model thought for too long on one turn), not a provider
 *                       fault. The server already auto-retries once from the
 *                       pre-turn transcript; this kind surfaces only when that
 *                       is exhausted. Recoverable: retry (thinking time is
 *                       non-deterministic, so a fresh attempt may finish).
 *   - `too_long`      — the turn hit a length/turn cap and can't continue.
 *   - `generic`       — anything else; an unclassified interruption.
 */
export const chatErrorKindValues = [
  "attachment",
  "attachment_history",
  "overloaded",
  "rate_limited",
  "timeout",
  "too_long",
  "generic",
] as const;
export type ChatErrorKind = (typeof chatErrorKindValues)[number];
export const chatErrorKindSchema = z.enum(chatErrorKindValues);

/**
 * The fix for a tool call the dispatch health floor refused on connection
 * health (#378 item 3). The floor's `{status:"not_allowed"}` envelope already
 * tells the *model* what happened and it narrates it; this payload rides the
 * same refusal to the *client* so the chat can offer the repair instead of
 * leaving an opaque narration. The integration slug is the tool-runtime slug
 * (short Google aliases like `"calendar"` included) — exactly what
 * `getIntegrationProvider` resolves on the web. It is the closed
 * {@link INTEGRATION_SLUGS} enum, not a free string: the payload persists on the
 * message row, and a slug the registry no longer knows must fail this parse so
 * the replay door can drop the offer instead of rendering a repair for nothing.
 *
 *   - `connect`   — no usable credential exists (`not_connected`).
 *   - `reconnect` — a credential exists but is unusable as-is:
 *                   `needs_reauth` or `missing_scope`; both are repaired by
 *                     re-running the provider's connect flow.
 */
export const chatConnectNudgeSchema = z.object({
  integration: z.enum(INTEGRATION_SLUGS),
  action: z.enum(["connect", "reconnect"]),
});
export type ChatConnectNudge = z.infer<typeof chatConnectNudgeSchema>;

/**
 * One agent's slice of a turn's spend: the boss run, or one sub-agent the boss
 * spawned. `subId` is `null` for the boss and the child's own `subId` for a
 * worker (`spawnSubAgent` stamps it on the child run's metadata).
 */
export const chatMessageAgentUsageSchema = z.object({
  subId: z.string().nullable(),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type ChatMessageAgentUsage = z.infer<typeof chatMessageAgentUsageSchema>;

/**
 * Token usage, model latency, and cost for one assistant turn, aggregated at
 * finalize from the turn's `api_call_log` rows. The totals cover the whole
 * turn: the boss run plus every sub-agent run the boss spawned, because
 * delegation moves most of a turn's spend into the children (see
 * `.lessons/model-cost-recompute-from-tokens.md`, where a boss-only number hid
 * the majority of the cost). `agents` carries the same money split per agent.
 * Surfaced only in a dev-gated readout under the reply; the numbers already
 * live in `api_call_log`, this is just the per-message rollup carried to the
 * client. All counts are whole tokens; `costUsd` is the summed snapshot cost in
 * dollars.
 */
export const chatMessageUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  /**
   * Sum of successful LLM request-to-stream-end durations for this turn. It
   * excludes tool execution and other workflow time, so outputTokens divided
   * by this value is model output throughput. Defaulted for durable messages
   * written before the field existed.
   */
  modelLatencyMs: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative(),
  /** How many LLM calls this turn made (one per generation / tool round). */
  calls: z.number().int().nonnegative(),
  /**
   * The distinct models that actually served this turn, with each one's call
   * count, most-used first. Reveals a silent provider fallback — e.g. a turn you
   * expected on `claude-sonnet-4-6` showing `gemini-3.5-flash` means the
   * Anthropic primary errored and `withFallback` degraded it (spend cap, 429).
   */
  models: z.array(z.object({ model: z.string(), calls: z.number().int().positive() })).default([]),
  /**
   * How the turn's cost divides across the agents that ran it, most expensive
   * first, boss included. One entry means the boss did the whole turn alone.
   * Empty on messages finalized before this split existed — a reader must treat
   * an absent split as "unknown", not as "the boss spent nothing".
   */
  agents: z.array(chatMessageAgentUsageSchema).default([]),
});
export type ChatMessageUsage = z.infer<typeof chatMessageUsageSchema>;

/**
 * Response of the turn start endpoint (`POST /api/chat/threads/:id/turn`),
 * discriminated on `outcome` so the client can tell three things apart on a
 * `2xx`: the turn started (a run exists for it), or the thread is busy (a
 * different turn is still in flight, so no run was created for this message).
 * A hard failure stays a non-`2xx` `ApiErrorResponse` — busy is deliberately
 * NOT an error, so the client can keep the message queued and retry when the
 * in-flight run completes rather than surfacing a failure toast (#488).
 *
 *   - `started` — a run for this exact user message exists (freshly created, or
 *                 the idempotent existing one for a duplicate submit). `runId`
 *                 may be `null` only in the rare recovery path where the run row
 *                 could not be re-read after a concurrent insert.
 *   - `busy`    — the thread already has a non-terminal run for a *different*
 *                 user message, so this start created nothing. `runId`, when
 *                 present, is that in-flight run — the one to await before
 *                 retrying.
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
// Back-compat aliases — deprecated, use `turnStartResponseSchema` / `TurnStartResponse`.
/** @deprecated Use `turnStartResponseSchema`. */
export const turnKickResponseSchema = turnStartResponseSchema;
/** @deprecated Use `TurnStartResponse`. */
export type TurnKickResponse = TurnStartResponse;

/**
 * Client-local queue cap for #489. At most this many turns may wait while a
 * reply streams; the cap lives here so web and server agree on the back-pressure
 * and `enqueue` can reject without importing server code.
 */
export const MAX_QUEUED_TURNS = 10;

/**
 * Single source of truth for "nothing to send" (#489, #488). Empty means no
 * trimmed text, no fresh files, no re-attached history files, and no structured
 * artifact target. Centralized so `useSendMessage`, `useChatQueue`, and
 * `ChatShell.onSend` cannot disagree.
 */
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
