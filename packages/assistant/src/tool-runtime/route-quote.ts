/**
 * The route quote of a discovery hit (ADR-0130 C1). `system.search_tools`, `mcp.list_tools`, and
 * `mcp.inspect_tool` each tell the model where a tool runs now, if it shows a card, and its read
 * class, so the model does not learn the route from a refused call. Each quote uses the inputs
 * and the two rules that dispatch uses (`callRequiresApproval`, `decideReadRoute`): the staging
 * arm, the policy rule, the tier, the read facts with the class, and Full Autonomy of
 * `approvalThreadId`. Thus a hit
 * quoted `script` is a call that a script can make. Dispatch decides again for each call, because
 * a policy can change between the two.
 */

import type {
  PolicyMode,
  ToolName,
  ToolReadPath,
  ToolRiskTier,
  ToolRouteQuote,
} from "@alfred/contracts";
import { resolvePolicyMode } from "@alfred/assistant/action-policies";
import { resolveMcpCallRouteFacts } from "@alfred/assistant/tool-runtime/mcp";
import { callRequiresApproval, toolRequiresApproval } from "./approval-rule";
import { stagingStore } from "./internal/dispatch/staging-store";
import { getTool, type RegisteredTool, type ToolStagingPolicy } from "./internal/registry";
import {
  declaredStructuredRead,
  decideReadRoute,
  NOT_A_CONFIRMED_READ,
  type ReadFacts,
} from "./read-route";

const MCP_CALL_TOOL = "mcp.call" satisfies ToolName;

/** What one discovery call shares for all of its hits. */
export interface RouteQuoteRun {
  userId: string;
  /**
   * The run reads through `system.code_run` (ADR-0124): a `code_run` run, or a script's nested
   * read. In another run each call is direct.
   */
  scriptReads: boolean;
  /**
   * The thread's Full Autonomy, which waives a card. Read at most one time, and only when the
   * rule would stage a card, as dispatch reads it.
   */
  fullAutonomy: () => Promise<boolean>;
}

/**
 * The run facts of a quote. `approvalThreadId` is the thread that dispatch reads Full Autonomy
 * from: the chat thread, or the parent thread of a sub-agent. No thread means no Full Autonomy.
 */
export function routeQuoteRun(args: {
  userId: string;
  readPath: ToolReadPath | undefined;
  approvalThreadId: string | undefined;
}): RouteQuoteRun {
  const { userId, approvalThreadId } = args;
  let read: Promise<boolean> | undefined;

  return {
    userId,
    scriptReads: args.readPath !== undefined,
    fullAutonomy: () => {
      read ??=
        approvalThreadId === undefined
          ? Promise.resolve(false)
          : stagingStore().readThreadFullAutonomy({ userId, threadId: approvalThreadId });

      return read;
    },
  };
}

/** The live approval of one call, from the inputs that `stageOrResumeStage` reads. */
async function requiresApproval(
  run: RouteQuoteRun,
  call: {
    staging: ToolStagingPolicy;
    policyMode: PolicyMode;
    riskTier: ToolRiskTier;
    facts: ReadFacts;
  },
): Promise<boolean> {
  const { staging, policyMode, riskTier } = call;
  const readClass = call.facts.readClass;
  const gated = toolRequiresApproval(policyMode, riskTier, readClass);

  return callRequiresApproval({
    staging,
    policyMode,
    riskTier,
    readClass,
    fullAutonomy: gated && (await run.fullAutonomy()),
  });
}

/** The quote from the approval of the call and its read facts. */
function quote(run: RouteQuoteRun, facts: ReadFacts, requiresApproval: boolean): ToolRouteQuote {
  const approval = requiresApproval ? "card" : "none";
  const readClass = facts.readClass;
  const classField = readClass === undefined ? {} : { class: readClass };

  if (!run.scriptReads) return { route: "direct", approval, ...classField };

  const route = decideReadRoute(facts, requiresApproval);

  return route.route === "script"
    ? { route: "script", approval: "none", ...classField }
    : { route: "direct", directReason: route.reason, approval, ...classField };
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
    connectionId: tool.connectionId,
    remoteName: tool.remoteName,
    catalogRevision: tool.catalogRevision,
  });

  const approval = await requiresApproval(run, {
    staging: getTool(MCP_CALL_TOOL)?.staging ?? "staged",
    policyMode: await resolvePolicyMode(run.userId, MCP_CALL_TOOL, policyIntegration),
    riskTier,
    facts,
  });

  return { quote: quote(run, facts, approval), riskTier };
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

  // The facts that dispatch reads for a call with no `resolveReadFacts`. Only `mcp.call` declares
  // one, and the guard above returns for it, because it also resolves its tier.
  const facts =
    tool.readClass === undefined ? NOT_A_CONFIRMED_READ : declaredStructuredRead(tool.readClass);

  const approval = await requiresApproval(run, {
    staging: tool.staging,
    policyMode: await resolvePolicyMode(run.userId, tool.name),
    riskTier: tool.riskTier,
    facts,
  });

  return quote(run, facts, approval);
}
