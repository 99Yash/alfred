import { z } from "zod";

/**
 * The core of a tool call the model has requested but not yet dispatched —
 * shared by the interactive chat turn and the sub-agent brief workflow. The
 * chat turn `.extend()`s this with a `segmentIndex` (the narration segment the
 * call follows); the background brief has no narration and uses the core as-is.
 */
export const pendingToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
});
export type PendingToolCall = z.infer<typeof pendingToolCallSchema>;
