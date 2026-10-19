import { isRecord } from "@alfred/contracts";

/** What a grounding eval's task returns: the tool call the agent chose, or `null` and its text. */
export interface GroundingTaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}

/** The diagnostic view of a tool-call input: the object, or `null` when no call or no object came back. */
export function toolCallArgs(input: unknown): Record<string, unknown> | null {
  return isRecord(input) ? input : null;
}
