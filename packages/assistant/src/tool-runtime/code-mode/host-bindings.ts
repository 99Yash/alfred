/**
 * The host functions of one `system.code_run` call (ADR-0124). Each read is a facade over a nested
 * dispatch (`ToolExecuteContext.hostRead`), so the gate, the staging row, the span, and the honest
 * result envelope stay in dispatch. Nothing here runs a tool's `execute` directly. The one
 * function that is not a read is the clock, `time.now()`.
 */

import {
  mcpToolRefSchema,
  jsonObjectSchema,
  type JsonValue,
  type ToolName,
} from "@alfred/contracts";
import { RunError } from "run";
import { z } from "zod";
import type { HostReadDispatcher, HostReadOutcome, RegisteredTool } from "../internal/registry";
import type { HostBinding } from "./run-read-program";

/**
 * `mcp.read(ref, args)`: `ref` as `mcp.list_tools` returns it, then the tool's arguments. The ref
 * has no catalog revision (ADR-0116 amendment 2026-11-18). A key that the ref does not have, such
 * as a revision that the model copied from an older result, is dropped: the server owns it.
 */
const mcpReadArgs = z.tuple([mcpToolRefSchema.strip(), jsonObjectSchema.optional()]);

const MCP_CALL_TOOL = "mcp.call" satisfies ToolName;

/** The guest path of the one host read that is not a tool name. */
export const MCP_READ_PATH = "mcp.read";

/** The guest path of the clock (ADR-0130 decision 7). */
export const TIME_NOW_PATH = "time.now";

/**
 * `time.now()`: the `system.current_time` snapshot, read live. A script's own `Date` is fixed for
 * the run and uses the server's zone. The clock is not a read, so it has no dispatch, no card, and
 * no ledger entry (ADR-0130 decision 2).
 */
export function timeNowBinding(snapshot: () => JsonValue): HostBinding {
  return {
    path: TIME_NOW_PATH,
    value: (guestArgs) => {
      if (guestArgs.length > 0) {
        throw new RunError(`${TIME_NOW_PATH} takes no arguments`, "invalid_input");
      }

      return snapshot();
    },
  };
}

/**
 * Reads the current catalog revision of one owned connection, or `null` when there is none. The
 * caller binds it to its user.
 */
export type CatalogRevisionReader = (connectionId: string) => Promise<string | null>;

export function readHostBindings(args: {
  readTools: readonly RegisteredTool[];
  hostRead: HostReadDispatcher;
  readCatalogRevision: CatalogRevisionReader;
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

  // One prepared catalog for each connection in this pass (ADR-0116 amendment 2026-11-18). The
  // first read on a connection pins its current revision, and each later read on that connection
  // uses the pin. The map holds the promise, so parallel first reads share one pin. The broker
  // refuses a read whose pin is no longer the live revision, so a catalog change during the pass
  // is a named failure (`mcp_catalog_changed`), not a silent refresh.
  const pins = new Map<string, Promise<string | null>>();

  const pinnedRevision = (connectionId: string): Promise<string | null> => {
    const pinned = pins.get(connectionId);

    if (pinned) return pinned;

    const pin = args.readCatalogRevision(connectionId);

    pins.set(connectionId, pin);

    return pin;
  };

  const mcpRead: HostBinding = {
    path: MCP_READ_PATH,
    read: async (guestArgs, requestIndex) => {
      const parsed = mcpReadArgs.safeParse(guestArgs);

      if (!parsed.success) {
        return refused(
          "invalid_input",
          "Call mcp.read(ref, args): `ref` as mcp.list_tools returned it, and `args` an object.",
        );
      }

      const [ref, toolArgs] = parsed.data;
      const catalogRevision = await pinnedRevision(ref.connectionId);

      // No owned connection, or no published catalog: nothing to pin, so no read can run.
      if (catalogRevision === null) {
        return refused(
          "not_allowed",
          `MCP connection '${ref.connectionId}' has no tool list to read. Find the tool again with mcp.list_tools.`,
        );
      }

      // Dispatch decides the route of the nested call, and the broker checks the live
      // descriptor again (ADR-0124 amendment 2026-11-18). A second copy here could disagree.
      return hostRead({
        toolName: MCP_CALL_TOOL,
        input: {
          connectionId: ref.connectionId,
          remoteName: ref.remoteName,
          catalogRevision,
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
  return { kind: "refused", refusal, message, call: undefined };
}
