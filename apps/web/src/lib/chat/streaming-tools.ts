import type { EventPayload } from "@alfred/contracts/events";

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean;
  /** Narration segment this call follows, ordering it against the narration trail. */
  segmentIndex: number;
}

export function applyStreamingToolEvent(
  tools: Map<string, StreamingToolCall>,
  event: EventPayload<"chat.tool">,
): void {
  if (event.nonExecution) {
    tools.delete(event.toolCallId);
    return;
  }

  const previous = tools.get(event.toolCallId);
  tools.set(event.toolCallId, {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    argsPreview: event.argsPreview ?? previous?.argsPreview,
    resultPreview: event.resultPreview ?? previous?.resultPreview,
    sanitized: event.sanitized ?? previous?.sanitized,
    segmentIndex: event.segmentIndex ?? previous?.segmentIndex ?? 0,
  });
}
