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

export function readHostBindings(args: {
  readTools: readonly RegisteredTool[];
  hostRead: HostReadDispatcher;
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

      // Dispatch decides the route of the nested call, and the broker checks the live
      // descriptor again (ADR-0124 amendment 2026-11-18). A second copy here could disagree.
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
