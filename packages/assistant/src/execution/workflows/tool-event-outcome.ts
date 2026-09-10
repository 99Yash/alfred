/**
 * The five fields a terminal dispatch result contributes to a `chat.tool`
 * event (and to the durable tool-call log): status, result preview, the
 * ADR-0070 sanitizer verdict, the non-execution flag, and — on a
 * connection-health bounce only — the client-facing connect nudge (#378 item
 * 3).
 *
 * Extracted because two surfaces now publish `chat.tool` — the chat turn for
 * the boss's own calls, and the brief workflow for a spawned sub-agent's calls
 * streaming into that same turn. `nonExecution` in particular has to be
 * derived identically on both: it is what makes the client retract an
 * optimistic card instead of showing an internal bounce as a user-facing
 * failure, and a surface that forgets it leaks dispatcher plumbing into chat.
 */

import type { CompletedToolCall } from "@alfred/assistant/tool-runtime";
import type { ChatConnectNudge } from "@alfred/contracts";
import { preview } from "./tool-preview";

export interface ToolEventOutcome {
  status: "succeeded" | "failed";
  resultPreview: string;
  /**
   * `preview()` lost something building `resultPreview`: a string shortened, an
   * array sliced, or an object key dropped. Carried beside `sanitized` because
   * it is the same kind of fact — a lossy-transform verdict only the producer
   * can state — and because a preview that still parses gives its readers no
   * way to notice. Every reader that treats `resultPreview` as the record it
   * came from needs it (#1018 review, S2).
   */
  resultTruncated?: true | undefined;
  /** ADR-0070: non-text bytes were stripped from the result before storage. */
  sanitized?: true | undefined;
  /** Rejected before execution — the client retracts the card entirely. */
  nonExecution?: true | undefined;
  /**
   * Set together with `nonExecution` when the bounce was connection health:
   * the one rejection that is deliberately user-visible (as a repair offer),
   * live and on the durable row.
   */
  connectNudge?: ChatConnectNudge | undefined;
}

export function toolEventOutcome(completion: CompletedToolCall): ToolEventOutcome {
  const result = preview(completion.result);
  return {
    status: completion.status,
    resultPreview: result.text,
    resultTruncated: result.truncated ? true : undefined,
    sanitized: completion.sanitized ? true : undefined,
    // Only a `failed` status can be a non-execution bounce; an executed call
    // reached the side-effect path by definition.
    nonExecution: completion.nonExecution ? true : undefined,
    connectNudge: completion.connectNudge,
  };
}
