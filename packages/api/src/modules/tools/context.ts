/**
 * The execution context one tool call runs against — built here rather than in
 * `./registry` so the registry stays a leaf. Declaring the tool *shape* needs
 * only the `Integrations` TYPE (erased at compile time); building a context needs
 * the `integrations` VALUE, which pulls `@alfred/db` (drizzle + pg) and
 * `@alfred/ingestion` into whatever imports it. Every tool module imports the
 * registry to declare itself; only the dispatcher builds a context.
 */

import { integrations } from "@alfred/integrations";
import type { RetryPolicy } from "@alfred/integrations/shared";

import type { ToolExecuteContext, ToolExecuteContextFields } from "./registry";

/**
 * The transient-retry envelope every provider bind inside a tool dispatch gets.
 *
 * Chosen against the turn's own budget rather than inherited from a library
 * default: one attempt can occupy the transport's full 30s timeout and there is no
 * dispatch-level tool timeout yet (see the `abortSignal` TODO on
 * {@link ToolExecuteContext}), so N attempts is N × 30s plus backoff against a
 * 180s chat-turn stream ceiling. Two attempts with a 1s cap keeps the worst case
 * near 61s — a rate-limited or briefly-500ing read still recovers within one turn,
 * and a hung upstream cannot eat the whole turn. Raise it only alongside a
 * per-call deadline.
 */
export const TOOL_DISPATCH_RETRY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 250,
  maxDelayMs: 1_000,
};

/**
 * Build the execution context for one tool call.
 *
 * The whole reason this is a function and not an object literal: `integrations`
 * must be bound to `userId`, and a literal lets the two disagree. Nothing about
 * `{ userId: a, integrations: integrations({ userId: b }) }` fails to compile,
 * and a tool would then read one user's data while every audit row said the
 * other. Deriving the bind here makes the mismatch unconstructible, and means no
 * caller — dispatcher, smoke script, or test — has to know that a bind is
 * something a context needs at all.
 */
export function toolExecuteContext(fields: ToolExecuteContextFields): ToolExecuteContext {
  return {
    ...fields,
    integrations: integrations({
      userId: fields.userId,
      retry: TOOL_DISPATCH_RETRY,
      accountRef: fields.accountRef,
    }),
  };
}
