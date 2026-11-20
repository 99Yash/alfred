/**
 * The fixed MCP tools (PRD #540). A remote tool never becomes a `ToolName`: the model names it
 * with `connectionId` and `remoteName` in the `mcp.call` args, and dispatch authorizes each call.
 * The server binds the catalog revision when the call is proposed (ADR-0088 amendment
 * 2026-11-18), so the model never sees or copies one.
 * `mcp.list_tools` and `mcp.inspect_tool` are local catalog reads on the fast path.
 */

import {
  assertNever,
  boundPassthroughBody,
  getStringPath,
  isJsonArray,
  isJsonObject,
  mcpCallInput,
  mcpCallModelInput,
  mcpToolInspectInputSchema,
  mcpToolSearchInputSchema,
  safeJsonParse,
  toJsonValue,
  truncatedCoverage,
  unknownEffectEnvelopeSchema,
  type McpCallInput,
  type JsonObject,
  type JsonValue,
  type McpToolRef,
  type ReadEvidenceRefDraft,
  type ResultRecipient,
  type ResultTruncation,
} from "@alfred/contracts";
import { resultRecipientOf } from "./passthrough";
import { itemEvidence, type DeliveredItem } from "../../item-evidence";
import { AppError, publicAppError } from "@alfred/contracts/app-errors";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import {
  builtInBorrowsGoogleCredential,
  inspectCurrentMcpToolLocal,
  integrationOfMcpConnection,
  McpClientError,
  mcpScopeAdmits,
  mcpServerIdsAdmittedBy,
  needsMcpReauthorization,
  readOwnedConnection,
  searchMcpToolsLocal,
  toCurrentToolDiscoveryPage,
  type ExternalToolRef,
  type McpCallEnvelope,
  type McpListToolsResult,
  type McpInspectToolResult,
  type McpRouteQuoter,
} from "@alfred/assistant/connections/mcp";
import {
  liveTool,
  readResult,
  type ReadResult,
  type RegisteredTool,
  type ToolExecuteContext,
} from "@alfred/assistant/tool-runtime";
import {
  getMcpExecutionBroker,
  readCurrentMcpCatalogRevision,
  resolveMcpCallProposalFacts,
  type McpBrokerOutcome,
  type McpCallProposalFacts,
} from "@alfred/assistant/tool-runtime/mcp";
import { quoteMcpToolRoute, routeQuoteRun } from "@alfred/assistant/tool-runtime/route-quote";

/** Model-safe projection of a broker outcome into an `mcp.call` tool result. */
export interface McpBrokerToolResult {
  /**
   * `false` when the remote tool failed or nothing was sent. `executedResultOutcome` reads it, so
   * the action record, the trace span, and the chat trail all show the call as failed. `tool_error`
   * and `blocked` are not failure statuses for every tool: a `system.*_workflow` draft is `blocked`
   * and `ok`. A `blocked` result keeps `retry: "blocked"`, because an earlier attempt may have
   * landed (`leavesEffectUnconfirmed`).
   */
  ok?: false;
  status: string;
  result?: unknown;
  retry?: "blocked";
  reason?: string;
  message?: string;
  /** Raw response fact, kept outside the bounded payload and saved for script-read replay. */
  hasBinaryContent?: true;
  /** Set when the one size rule cut the payload of a direct call (`withResponseFacts`). */
  truncation?: ResultTruncation;
}

/**
 * Bind the call to the connection's current catalog revision (ADR-0088 amendment 2026-11-18).
 * Dispatch runs this on a fresh proposal, before the refusals, the tier, and the read facts, and
 * the staging row saves the result. A revision in the model's input is dropped: the server owns
 * it. A Code Mode read keeps the revision that its pass pinned (ADR-0116 amendment 2026-11-18).
 */
async function bindCatalogRevision(
  input: McpCallInput,
  ctx: { userId: string; runContext: { readPath?: string | undefined } },
): Promise<McpCallInput> {
  if (ctx.runContext.readPath === "code_run_host" && input.catalogRevision !== undefined) {
    return input;
  }

  const { catalogRevision: _fromCaller, ...call } = input;

  const current = await readCurrentMcpCatalogRevision({
    userId: ctx.userId,
    connectionId: input.connectionId,
  });

  // No published catalog: the call has no revision, so it keeps the `high` floor and never runs.
  return current === null ? call : { ...call, catalogRevision: current };
}

/**
 * One identity read for each bound call. The registry passes the same parsed input object to the
 * refusal, the tier, and the read facts of one decision, so the three share this read, and a
 * catalog change between them cannot give them different answers.
 */
const proposalFactsByInput = new WeakMap<McpCallInput, Promise<McpCallProposalFacts>>();

function proposalFacts(input: McpCallInput, userId: string): Promise<McpCallProposalFacts> {
  const cached = proposalFactsByInput.get(input);

  if (cached) return cached;

  const facts = resolveMcpCallProposalFacts({
    userId,
    connectionId: input.connectionId,
    remoteName: input.remoteName,
    catalogRevision: input.catalogRevision,
  });

  proposalFactsByInput.set(input, facts);

  return facts;
}

/**
 * Who receives the result (ADR-0124 amendment 2026-11-18 (b)). `model`: a direct call, so the
 * ADR-0074 bounds apply before the model sees it. `script`: a script read gets the whole sanitized
 * response, and dispatch refuses one above the host's delivery cap before it saves it.
 */

function brokerResult(outcome: McpBrokerOutcome, recipient: ResultRecipient): McpBrokerToolResult {
  switch (outcome.status) {
    case "completed":
      return withResponseFacts({ status: "completed" }, outcome.envelope, recipient);
    case "tool_error":
      // Only idempotent reads reach here. MCP `isError` does not prove no effect occurred.
      return withResponseFacts({ ok: false, status: "tool_error" }, outcome.envelope, recipient);
    case "blocked":
      return {
        ok: false,
        status: "blocked",
        retry: "blocked",
        reason: outcome.reason,
        message: outcome.message,
      };
    case "ambiguous":
      // Not a retryable error. The shared schema keeps this and the gate's recognizer in step.
      return unknownEffectEnvelopeSchema.parse({
        status: "unknown",
        retry: "blocked",
        message: outcome.message,
      });
    default:
      return assertNever(outcome, "MCP broker outcome");
  }
}

/**
 * Local dev shares the real Google account, so a Google Workspace MCP write runs only where
 * Gmail mailbox writes are on (ADR-0126). A read passes: its selected descriptor asserts
 * `readOnlyHint` and no review says otherwise.
 */
async function refuseGoogleWorkspaceWrite(
  input: McpCallInput,
  userId: string,
  endpointUrl: string,
): Promise<string | null> {
  if (gmailMailboxWritesEnabled() || !builtInBorrowsGoogleCredential(endpointUrl)) return null;

  const { readOnly } = await proposalFacts(input, userId);

  return readOnly
    ? null
    : "Google writes are off in this environment (GMAIL_MAILBOX_WRITES_ENABLED), so this call did not run.";
}

/**
 * The response for its recipient. A script gets the whole result. The model gets the copy that the
 * one size rule bounds (`boundPassthroughBody`), so the result fits and the chat boundary does not
 * cut it again.
 */
function withResponseFacts(
  head: Pick<McpBrokerToolResult, "ok" | "status">,
  envelope: McpCallEnvelope,
  recipient: ResultRecipient,
): McpBrokerToolResult {
  const binary = envelope.hasBinaryContent ? { hasBinaryContent: true as const } : {};

  if (recipient === "script") return { ...head, result: envelope.result, ...binary };

  const bounded = boundPassthroughBody(withParsedJsonText(envelope.result));

  return {
    ...head,
    result: bounded.value,
    ...binary,
    ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
  };
}

/**
 * The result with each text block that holds a JSON object or list parsed, so the size rule bounds
 * it as structure: whole items, the cursor, and the count of cut items (ADR-0130 decision 5). The
 * block keeps its place, with `json` in place of `text`. Other blocks stay as they are.
 */
function withParsedJsonText(result: McpCallEnvelope["result"]): JsonValue {
  const value = toJsonValue(result);

  if (!isJsonObject(value) || !isJsonArray(value.content)) return value;

  const content = value.content.map((block) => {
    const text = getStringPath(block, "text");
    const json = text === undefined ? null : jsonContainerOf(text);

    if (json === null || !isJsonObject(block) || block.type !== "text") return block;

    const { text: _text, ...rest } = block;

    return { ...rest, json };
  });

  return { ...value, content };
}

/** The parsed text when it is a JSON object or list, else `null`. */
function jsonContainerOf(text: string): JsonObject | readonly JsonValue[] | null {
  const start = text.trimStart()[0];

  if (start !== "{" && start !== "[") return null;

  const parsed = safeJsonParse(text);

  return isJsonArray(parsed) || isJsonObject(parsed) ? parsed : null;
}

export const mcpTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "mcp",
    action: "call",
    // An outbound call to an external server always confirms (ADR-0069).
    riskTier: "high",
    replay: "safe",
    description:
      "Invoke a tool on a connected MCP server. Supply the `connectionId` and `remoteName` of the ref returned by system.search_tools or mcp.list_tools, plus `arguments` matching the tool schema. Use mcp.inspect_tool if you need the full schema. The call is validated against the server's exact schema and routed through Alfred's approval + durable-execution boundary; a write that may have been delivered but not confirmed comes back as `status:\"unknown\"` and MUST NOT be repeated — check its state instead.",
    discovery: {
      aliases: ["mcp call", "call connected tool", "run mcp tool", "invoke mcp"],
      tags: ["mcp", "integration", "external"],
      entities: ["mcp tool", "connection"],
      verbs: ["call", "invoke", "run", "execute"],
      relatedTools: ["mcp.list_tools"],
    },
    inputSchema: mcpCallInput,
    // The model names the tool. Only the server writes `catalogRevision` (ADR-0088 amendment).
    modelInputSchema: mcpCallModelInput,
    // Before every decision, so the refusal, the tier, the read facts, and the staging row all
    // read the one revision that the server bound.
    bindServerFields: bindCatalogRevision,
    // Three downgrades: a reviewed policy row or a code-owned built-in entry on a `readOnlyHint`
    // descriptor (#541, ADR-0096 amendment), or a read-only resource plus the hint (ADR-0096).
    // Reads the persisted catalog at the bound revision only. Any doubt stays high.
    resolveRiskTier: async (input, ctx) => (await proposalFacts(input, ctx.userId)).riskTier,
    // A built-in follows its provider's rule, so the GitHub Auto/Gated setting governs GitHub reads.
    // A user-added server has no provider and keeps the `mcp` rule. A resolved tool also names its
    // server tool, whose own rule beats the integration mode at this descriptor (ADR-0130 (c)).
    resolvePolicyTarget: async (input, ctx) =>
      (await proposalFacts(input, ctx.userId)).policyTarget ?? {
        integration: (await integrationOfMcpConnection(ctx.userId, input.connectionId)) ?? "mcp",
      },
    // Before the staging row, so a refused call gets no approval card. Only a fresh proposal
    // runs this. The broker checks the connection that runs again.
    refuseProposal: async (input, ctx) => {
      const connection = await readOwnedConnection(input.connectionId, ctx.userId);

      // An unknown connection fails in the broker with its own error.
      if (!connection) return null;

      const serverIds = await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations);

      if (!mcpScopeAdmits(serverIds, connection.serverId)) {
        return publicAppError("mcp_connection_outside_scope").message;
      }

      // A script read whose pass pin is no longer current: the catalog changed during the pass.
      // Name it here, before the floor sends the read to a card (ADR-0116 amendment 2026-11-18).
      if (
        ctx.runContext.readPath === "code_run_host" &&
        (await proposalFacts(input, ctx.userId)).stale
      ) {
        return publicAppError("mcp_catalog_changed").message;
      }

      return refuseGoogleWorkspaceWrite(input, ctx.userId, connection.server.endpointUrl);
    },
    // ADR-0124 amendment 2026-11-18: the read authority and the declared output of the bound
    // descriptor. The route decision reads them, and the broker checks them again before delivery.
    resolveReadFacts: async (input, ctx) => (await proposalFacts(input, ctx.userId)).facts,
    // A confirmed read returns the server's text. A write can echo the model's input, so the
    // fetch_url sources count only a call whose tier a confirmed read lowered (ADR-0130).
    outsideText: true,
    riskTierDowngradeReason:
      "#541 reviewed policy binds the exact owned MCP descriptor and catalog revision and lowers only a readOnlyHint tool (ADR-0069 amendment); a code-owned built-in entry binds the exact descriptor the same way (ADR-0096 amendment 2026-11-13); ADR-0096 grants a read-only built-in endpoint plus a published readOnlyHint",
    execute: async (input, ctx) => {
      if (!ctx.stagingId) {
        // Always staged, so a missing id is a wiring bug.
        throw new Error("mcp.call executed without a staging row id");
      }

      const scriptRead = ctx.runContext.readPath === "code_run_host";

      // The server bound no revision: the connection had no published catalog when the call was
      // proposed. Execution never selects a descriptor on its own, so the call does not run.
      if (input.catalogRevision === undefined) {
        if (scriptRead) throw new AppError("mcp_catalog_changed");
        throw new AppError("mcp_catalog_stale");
      }

      // The saved revision of the proposal. The broker refuses on drift, and never selects the
      // newest descriptor (ADR-0088 amendment 2026-11-18).
      const ref: ExternalToolRef = {
        kind: "mcp",
        connectionId: input.connectionId,
        remoteName: input.remoteName,
        catalogRevision: input.catalogRevision,
      };

      let outcome: McpBrokerOutcome;

      try {
        outcome = await getMcpExecutionBroker().callTool({
          userId: ctx.userId,
          stagingId: ctx.stagingId,
          traceId: ctx.runId,
          ref,
          arguments: input.arguments,
          // `input` is the effective input (an approval edit included), on a resume and a replay too.
          serverScope: await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations),
          // A script read: the broker checks the live descriptor and review again (ADR-0124).
          ...(scriptRead ? { requireScriptRead: true } : {}),
          // The broker copies correlation ids from the staging row, so they cannot drift.
        });
      } catch (error) {
        // Only errors that escape the broker reach here; ambiguous outcomes keep their barrier.
        if (needsMcpReauthorization(error)) {
          throw new AppError("mcp_reauth_required", { cause: error });
        }

        // A generic "try again" makes the model resend the same call, so these name the next step.
        if (error instanceof McpClientError) {
          // The catalog changed after the bind. A direct call binds again when the model calls
          // again. A script read failed against its pass pin, so the script must run again
          // (ADR-0116 amendment 2026-11-18): the host never refreshes the pin silently.
          if (error.code === "catalog_stale") {
            if (scriptRead) throw new AppError("mcp_catalog_changed", { cause: error });
            throw new AppError("mcp_catalog_stale", { cause: error });
          }

          if (error.code === "arguments_rejected") {
            throw new AppError("mcp_arguments_rejected", { cause: error });
          }

          if (error.code === "outside_scope") {
            throw new AppError("mcp_connection_outside_scope", { cause: error });
          }
        }

        throw error;
      }

      return brokerResult(outcome, resultRecipientOf(ctx.runContext));
    },
    // The evidence record (ADR-0124): the response is opaque, so the item is the whole result,
    // and its id is the remote tool at its catalog revision. The host-call row keeps the
    // arguments, and the `mcp_invocation` row of the nested staging row keeps the call. A script
    // read is never cut by Alfred, so `truncation` marks only a direct call's size cut. An MCP
    // response states no pagination of its own, so no provider gap is recorded here.
    readEvidence: (output, input) =>
      output.ok === false || output.result === undefined
        ? itemEvidence([])
        : itemEvidence(
            [
              {
                ref: {
                  kind: "record",
                  store: "mcp_call",
                  id: `${input.connectionId}/${input.remoteName}`,
                  depth: "body",
                  // Execute refuses a call with no bound revision, so a result always has one.
                  ...(input.catalogRevision === undefined
                    ? {}
                    : { version: input.catalogRevision }),
                },
                item: output.result,
              },
            ],
            truncatedCoverage(output.truncation !== undefined),
          ),
  }),
  liveTool({
    integration: "mcp",
    action: "list_tools",
    riskTier: "no_risk",
    replay: "safe",
    codeModeRead: "ordinary",
    description:
      'Search the tools in all connected MCP catalogs. Returns compact hits with an exact `ref`, namespace, and connection identity. `query` matches tool names, titles, and descriptions: every word must match, and a word that names the connection ("railway" for Railway) is skipped. Scope with `namespace` or `connectionId`; continue with `cursor`. Use mcp.inspect_tool to inspect a full descriptor. Each hit gives `route`: `script` runs in a script as mcp.read(ref, args), and `direct` runs only as a direct mcp.call, with `directReason`. `approval: "card"` means the call shows the user an approval card. This is a local read.',
    discovery: {
      aliases: ["list mcp tools", "mcp catalog", "what mcp tools", "connected tools"],
      tags: ["mcp", "integration", "discovery"],
      entities: ["mcp tool", "connection", "catalog"],
      verbs: ["list", "discover", "browse", "search"],
      relatedTools: ["mcp.call"],
    },
    staging: "fast_path",
    // `mcp` is not `system`, so it keeps the policy gate. This read has no outbound call.
    policyGateWaiver:
      "#540 clarification #5: bounded local read of Alfred's own validated MCP catalog — no outbound action, nothing to approve",
    inputSchema: mcpToolSearchInputSchema,
    // The model gets refs with no revision. The evidence record keeps the revision of each hit,
    // which is not in the model-facing output.
    execute: async (input, ctx): Promise<ReadResult<McpListToolsResult>> => {
      const page = await searchMcpToolsLocal({
        userId: ctx.userId,
        serverIds: await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations),
        ...input,
      });

      const output = await toCurrentToolDiscoveryPage(page, routeQuoter(ctx));

      return readResult(
        output,
        itemEvidence(
          output.tools.map((hit, index) =>
            mcpToolItem(hit.ref, page.tools[index]?.ref.catalogRevision, "hit", hit),
          ),
          output.nextCursor ? { morePages: true, returned: output.tools.length } : undefined,
        ),
      );
    },
    readEvidence: "returned_by_execute",
  }),
  liveTool({
    integration: "mcp",
    action: "inspect_tool",
    riskTier: "no_risk",
    replay: "safe",
    codeModeRead: "ordinary",
    description:
      "Inspect one connected MCP tool by the ref returned by mcp.list_tools or system.search_tools. Pass only `ref`. The result gives `route` and `approval`, as mcp.list_tools does.",
    discovery: {
      aliases: ["inspect mcp tool", "mcp tool schema"],
      tags: ["mcp", "integration", "discovery"],
      entities: ["mcp tool", "descriptor"],
      verbs: ["inspect", "describe"],
      relatedTools: ["mcp.list_tools", "mcp.call"],
    },
    staging: "fast_path",
    policyGateWaiver: "#540: exact local read of Alfred's validated MCP catalog",
    inputSchema: mcpToolInspectInputSchema,
    // The current descriptor: the ref has no revision, so it cannot go stale.
    execute: async (input, ctx): Promise<ReadResult<McpInspectToolResult>> => {
      const { result, catalogRevision } = await inspectCurrentMcpToolLocal({
        userId: ctx.userId,
        ref: input.ref,
        serverIds: await mcpServerIdsAdmittedBy(ctx.userId, ctx.allowedIntegrations),
        quoteRoute: routeQuoter(ctx),
      });

      return readResult(
        result,
        itemEvidence(
          result.status === "tool"
            ? [mcpToolItem(result.ref, catalogRevision, "body", result)]
            : [],
        ),
      );
    },
    readEvidence: "returned_by_execute",
  }),
];

/**
 * The route quote of each hit (ADR-0130 C1). In a script the read path is `code_run_host`, so a
 * hit quotes `script` only when `mcp.read` can call it.
 */
function routeQuoter(
  ctx: Pick<ToolExecuteContext, "userId" | "runContext" | "approvalThreadId">,
): McpRouteQuoter {
  const run = routeQuoteRun({
    userId: ctx.userId,
    readPath: ctx.runContext.readPath,
    approvalThreadId: ctx.approvalThreadId,
  });

  return async (ref) => (await quoteMcpToolRoute(run, ref)).quote;
}

/** One MCP tool descriptor in the evidence record (ADR-0124), at its catalog revision. */
function mcpToolItem(
  ref: McpToolRef,
  catalogRevision: string | undefined,
  depth: ReadEvidenceRefDraft["depth"],
  item: unknown,
): DeliveredItem {
  return {
    ref: {
      kind: "record",
      store: "mcp_tool",
      id: `${ref.connectionId}/${ref.remoteName}`,
      depth,
      ...(catalogRevision === undefined ? {} : { version: catalogRevision }),
    },
    item,
  };
}
