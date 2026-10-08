/**
 * The fields a finished dispatch adds to a `chat.tool` event. Chat and sub-agent cards must derive
 * them the same way.
 */

import type { CompletedToolCall } from "@alfred/assistant/tool-runtime";
import type { ChatConnectNudge } from "@alfred/contracts";
import { preview } from "./tool-preview";

export interface ToolEventOutcome {
  status: "succeeded" | "failed";
  resultPreview: string;
  /** `resultPreview` lost data. It may still parse, so a reader cannot tell otherwise. */
  resultTruncated?: true | undefined;
  /** Bytes were stripped from the result (ADR-0070). */
  sanitized?: true | undefined;
  /** Rejected before it ran; the client removes the card. */
  nonExecution?: true | undefined;
  /** A connection-health bounce, shown to the user as a repair offer. */
  connectNudge?: ChatConnectNudge | undefined;
}

export function toolEventOutcome(completion: CompletedToolCall): ToolEventOutcome {
  const result = preview(completion.result);

  return {
    status: completion.status,
    resultPreview: result.text,
    resultTruncated: result.truncated ? true : undefined,
    sanitized: completion.sanitized ? true : undefined,
    nonExecution: completion.nonExecution ? true : undefined,
    connectNudge: completion.connectNudge,
  };
}
