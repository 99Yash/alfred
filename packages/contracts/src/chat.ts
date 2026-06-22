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
 *   - `attachment`    — the model couldn't read an attached file (bad/oversized
 *                       image, unsupported type). Recoverable: drop it + retry.
 *   - `overloaded`    — a transient provider fault (5xx / "internal error" /
 *                       overloaded / network). Recoverable: retry.
 *   - `rate_limited`  — upstream throttling (429). Recoverable: wait + retry.
 *   - `too_long`      — the turn hit a length/turn cap and can't continue.
 *   - `generic`       — anything else; an unclassified interruption.
 */
export const chatErrorKindValues = [
  "attachment",
  "overloaded",
  "rate_limited",
  "too_long",
  "generic",
] as const;
export type ChatErrorKind = (typeof chatErrorKindValues)[number];
export const chatErrorKindSchema = z.enum(chatErrorKindValues);
