/**
 * The host functions of one `system.code_run` call (ADR-0124). Each one is a facade over a nested
 * dispatch (`ToolExecuteContext.hostRead`), so the gate, the staging row, the span, and the honest
 * result envelope stay in dispatch. Nothing here runs a tool's `execute` directly.
 */

import { mcpExternalToolRefSchema, jsonObjectSchema, type ToolName } from "@alfred/contracts";
import { z } from "zod";
import type { HostReadDispatcher, HostReadOutcome, RegisteredTool } from "../internal/registry";
import type { HostBinding } from "./run-read-program";

/** `mcp.read(ref, args)`: `ref` exactly as `mcp.list_tools` returns it, then the tool's arguments. */
const mcpReadArgs = z.tuple([mcpExternalToolRefSchema, jsonObjectSchema.optional()]);

const MCP_CALL_TOOL = "mcp.call" satisfies ToolName;

/** The guest path of the one host function that is not a tool name. */
export const MCP_READ_PATH = "mcp.read";

export interface McpReadOnlyCheck {
  (ref: { connectionId: string; remoteName: string; catalogRevision: string }): Promise<boolean>;
}

export function readHostBindings(args: {
  readTools: readonly RegisteredTool[];
  hostRead: HostReadDispatcher;
  /** The selected descriptor's `readOnlyHint` (`isSelectedMcpToolReadOnly`). A fake in an eval. */
  isReadOnlyMcpTool: McpReadOnlyCheck;
}): HostBinding[] {
  const { hostRead } = args;

  const toolBindings = args.readTools.map(
    (tool): HostBinding => ({
      path: tool.name,
      read: async (guestArgs, requestIndex) => {
        if (guestArgs.length > 1) {
          return refused("invalid_input", `${tool.name} takes one input object.`);
        }

        return hostRead({ toolName: tool.name, input: guestArgs[0] ?? {}, requestIndex });
      },
    }),
  );

  const mcpRead: HostBinding = {
    path: MCP_READ_PATH,
    read: async (guestArgs, requestIndex) => {
      const parsed = mcpReadArgs.safeParse(guestArgs);

      if (!parsed.success) {
        return refused(
          "invalid_input",
          "Call mcp.read(ref, args): `ref` exactly as mcp.list_tools returned it, and `args` an object.",
        );
      }

      const [ref, toolArgs] = parsed.data;

      // A second barrier: the gate also refuses a write, because a write keeps the `high` floor.
      if (!(await args.isReadOnlyMcpTool(ref))) {
        return refused(
          "not_a_read",
          `${ref.remoteName} is not marked read-only, so a script cannot call it.`,
        );
      }

      return hostRead({
        toolName: MCP_CALL_TOOL,
        input: {
          connectionId: ref.connectionId,
          remoteName: ref.remoteName,
          catalogRevision: ref.catalogRevision,
          arguments: toolArgs ?? {},
        },
        requestIndex,
      });
    },
  };

  return [...toolBindings, mcpRead];
}

function refused(
  refusal: Extract<HostReadOutcome, { kind: "refused" }>["refusal"],
  message: string,
): HostReadOutcome {
  return { kind: "refused", refusal, message };
}
