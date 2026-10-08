/** What a grounding eval's task returns: the tool call the agent chose, or `null` and its text. */
export interface GroundingTaskOutput {
  toolName: string | null;
  args: Record<string, unknown> | null;
  text: string;
}
