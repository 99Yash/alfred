import { z } from "zod";

/**
 * A tool call the model requested but that is not yet dispatched. Chat extends it with
 * `segmentIndex`.
 */
export const pendingToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
});
