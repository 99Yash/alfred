import { z } from "zod";

/**
 * Chat model tier — the user-selectable depth for a chat turn. The single
 * source of truth for the tier literal, shared so the web bundle can reference
 * it without pulling in `@alfred/ai` (Node-only): the composer's tier picker
 * and the send-message hook both previously hand-declared the same literal.
 * `@alfred/ai`'s `getChatModel` maps each tier to a concrete model; see
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
 * Token usage + cost for one assistant turn, aggregated at finalize from the
 * turn's `api_call_log` rows (the boss run — sub-agent child runs are billed
 * separately and not folded in here). Surfaced only in a dev-gated readout
 * under the reply; the numbers already live in `api_call_log`, this is just the
 * per-message rollup carried to the client. All counts are whole tokens;
 * `costUsd` is the summed snapshot cost in dollars.
 */
export const chatMessageUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
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
});
export type ChatMessageUsage = z.infer<typeof chatMessageUsageSchema>;

/**
 * Response of the turn-kick endpoint (`POST /api/chat/threads/:id/turn`),
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
 *                 user message, so this kick created nothing. `runId`, when
 *                 present, is that in-flight run — the one to await before
 *                 retrying.
 */
export const turnKickResponseSchema = z.discriminatedUnion("outcome", [
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
export type TurnKickResponse = z.infer<typeof turnKickResponseSchema>;
