import { z } from "zod";
import { normalizeToolInputKeys } from "./internal/dispatch/normalize-keys";

/** The join arm reads `childRunId` off a `staging: "join"` call, without the tool's `execute`. */
export const joinToolInput = z.object({ childRunId: z.string().min(1) });

/**
 * The `childRunId` of a join call's raw model input, read the way dispatch reads it: keys
 * normalized first, so `child_run_id` resolves to the same child the join arm awaited.
 */
export function joinChildRunId(input: unknown): string | null {
  const parsed = joinToolInput.safeParse(normalizeToolInputKeys(input, joinToolInput).input);

  return parsed.success ? parsed.data.childRunId : null;
}
