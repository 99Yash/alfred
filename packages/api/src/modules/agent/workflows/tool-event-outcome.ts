/**
 * The four fields a terminal dispatch result contributes to a `chat.tool`
 * event (and to the durable tool-call log): status, result preview, the
 * ADR-0070 sanitizer verdict, and the non-execution flag.
 *
 * Extracted because two surfaces now publish `chat.tool` — the chat turn for
 * the boss's own calls, and the brief workflow for a spawned sub-agent's calls
 * streaming into that same turn. `nonExecution` in particular has to be
 * derived identically on both: it is what makes the client retract an
 * optimistic card instead of showing an internal bounce as a user-facing
 * failure, and a surface that forgets it leaks dispatcher plumbing into chat.
 */

import type { CompletedToolCall } from "../../tool-runtime";
import { preview } from "./tool-preview";

export interface ToolEventOutcome {
  status: "succeeded" | "failed";
  resultPreview: string;
  /** ADR-0070: non-text bytes were stripped from the result before storage. */
  sanitized?: true | undefined;
  /** Rejected before execution — the client retracts the card entirely. */
  nonExecution?: true | undefined;
}

export function toolEventOutcome(completion: CompletedToolCall): ToolEventOutcome {
  return {
    status: completion.status,
    resultPreview: preview(completion.result),
    sanitized: completion.sanitized ? true : undefined,
    // Only a `failed` status can be a non-execution bounce; an executed call
    // reached the side-effect path by definition.
    nonExecution: completion.nonExecution ? true : undefined,
  };
}
