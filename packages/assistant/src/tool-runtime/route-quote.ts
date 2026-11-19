/**
 * The route quote of a discovery hit (ADR-0130 C1). `system.search_tools`, `mcp.list_tools`, and
 * `mcp.inspect_tool` each tell the model where a tool runs now and if it shows a card, so the
 * model does not learn the route from a refused call. Each quote uses the inputs and the two
 * rules that dispatch uses (`callRequiresApproval`, `decideReadRoute`), so a hit quoted `script`
 * is a call that a script can make. Dispatch decides again for each call, because a policy can
 * change between the two.
 */

import type { ToolName, ToolRiskTier, ToolRouteQuote } from "@alfred/contracts";
import { resolvePolicyMode } from "@alfred/assistant/action-policies";
import { resolveMcpCallRouteFacts } from "@alfred/assistant/tool-runtime/mcp";
import { callRequiresApproval } from "./approval-rule";
import { stagingStore } from "./internal/dispatch/staging-store";
import { getTool, type RegisteredTool } from "./internal/registry";
import {
  DECLARED_STRUCTURED_READ,
  decideReadRoute,
  NOT_A_CONFIRMED_READ,
  type ReadFacts,
} from "./read-route";

const MCP_CALL_TOOL = "mcp.call" satisfies ToolName;

/** What one discovery call reads one time for all of its hits. */
export interface RouteQuoteRun {
  userId: string;
  /**
   * The run reads through `system.code_run` (ADR-0124): a `code_run` run, or a script's nested
   * read. In another run each call is direct.
   */
  scriptReads: boolean;
  /** The thread's Full Autonomy waives a card, so it can send a gated read to a script. */
  fullAutonomy: boolean;
}

/**
 * Read the run facts of a quote. Full Autonomy is read live, as dispatch reads it. No thread
 * means a background run, which has no Full Autonomy.
 */
export async function readRouteQuoteRun(args: {
  userId: string;
  readPath: string | undefined;
  threadId: string | undefined;
}): Promise<RouteQuoteRun> {
  const fullAutonomy =
    args.threadId === undefined
      ? false
      : await stagingStore().readThreadFullAutonomy({
          userId: args.userId,
          threadId: args.threadId,
        });

  return {
    userId: args.userId,
    scriptReads: args.readPath === "code_run" || args.readPath === "code_run_host",
    fullAutonomy,
  };
}

/** The quote from the approval of the call and its read facts. */
function quote(run: RouteQuoteRun, facts: ReadFacts, requiresApproval: boolean): ToolRouteQuote {
  const approval = requiresApproval ? "card" : "none";

  if (!run.scriptReads) return { route: "direct", approval };

  const route = decideReadRoute(facts, requiresApproval);

  return route.route === "script"
    ? { route: "script", approval: "none" }
    : { route: "direct", directReason: route.reason, approval };
}

/**
 * The quote of one connected MCP tool at the catalog revision that the hit came from, and its
 * tier. One identity read gives the tier, the read facts, and the policy rule, as for a proposal.
 */
export async function quoteMcpToolRoute(
  run: RouteQuoteRun,
  tool: { connectionId: string; remoteName: string; catalogRevision: string },
): Promise<{ quote: ToolRouteQuote; riskTier: ToolRiskTier }> {
  const { riskTier, facts, policyIntegration } = await resolveMcpCallRouteFacts({
    userId: run.userId,
    ...tool,
  });

  const requiresApproval = callRequiresApproval({
    staging: getTool(MCP_CALL_TOOL)?.staging ?? "staged",
    policyMode: await resolvePolicyMode(run.userId, MCP_CALL_TOOL, policyIntegration),
    riskTier,
    fullAutonomy: run.fullAutonomy,
  });

  return { quote: quote(run, facts, requiresApproval), riskTier };
}

/**
 * The quote of one curated tool, or `null` when its tier or its policy rule comes from its input
 * (`mcp.call` with no ref). With no input, a quote for such a tool would be a guess.
 */
export async function quoteCuratedToolRoute(
  run: RouteQuoteRun,
  tool: RegisteredTool,
): Promise<ToolRouteQuote | null> {
  if (tool.resolvesRiskTier || tool.resolvesPolicyIntegration) return null;

  const requiresApproval = callRequiresApproval({
    staging: tool.staging,
    policyMode: await resolvePolicyMode(run.userId, tool.name),
    riskTier: tool.riskTier,
    fullAutonomy: run.fullAutonomy,
  });

  // The facts that dispatch reads for a curated call with no `resolveReadFacts`.
  return quote(
    run,
    tool.codeModeRead ? DECLARED_STRUCTURED_READ : NOT_A_CONFIRMED_READ,
    requiresApproval,
  );
}
