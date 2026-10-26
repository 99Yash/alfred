import type { RegisteredTool, ToolExecuteContext } from "@alfred/assistant/tool-runtime";

/**
 * Parse `input` through the tool's schema and run it, as dispatch does without the staging row.
 * A schema failure throws, so a test that drives `execute` directly cannot pass on a bad fixture.
 * Returns the model-facing output only.
 */
export async function executeTool(
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<unknown> {
  const binding = tool.bind(input);

  if (!binding.success) throw binding.error;

  return (await binding.call.execute(ctx)).output;
}
