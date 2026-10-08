/**
 * Builds a tool call's context. It lives outside the registry and is not re-exported
 * from `./index`, because the `integrations` value pulls `@alfred/db` into every importer.
 */

import { integrations } from "@alfred/integrations";
import { search } from "@alfred/corpus";
import { RETRY_BASE_DELAY_MS, type RetryPolicy } from "@alfred/integrations/shared";

import type { ToolExecuteContext, ToolExecuteContextFields } from "./internal/registry";

/**
 * Each attempt can take the full 30s fetch timeout, against a 180s turn ceiling.
 * Two attempts keep the worst case near 61s. Raise it only with a per-call deadline.
 */
const TOOL_DISPATCH_RETRY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: RETRY_BASE_DELAY_MS,
  maxDelayMs: 1_000,
};

/** A function, not a literal, so `integrations` cannot bind a different user than `userId`. */
export function toolExecuteContext(fields: ToolExecuteContextFields): ToolExecuteContext {
  return {
    ...fields,
    integrations: integrations({
      userId: fields.userId,
      retry: TOOL_DISPATCH_RETRY,
      accountRef: fields.accountRef,
    }),
    corpus: { search },
  };
}
