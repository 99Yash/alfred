import {
  type IntegrationSlug,
  LIVE_PROVIDERS,
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
} from "@alfred/contracts";
import { resolvePolicyMode } from "@alfred/assistant/action-policies";
import {
  listOwnedConnections,
  mcpScopeAdmits,
  mcpServerIdsAdmittedBy,
  type McpServerScope,
} from "@alfred/assistant/connections/mcp";
import { availableToolNamesByIntegration } from "@alfred/assistant/tool-runtime";
import {
  isDeclaredScriptRead,
  toolAlwaysWaitsForApproval,
} from "@alfred/assistant/tool-runtime/approval-rule";

/**
 * One line per connected integration for the system prompt (ADR-0053). Grounding only;
 * the dispatcher enforces access. Computed once per run so the prompt prefix stays cache-stable.
 */

const CONNECTED_LIST_RULES =
  "Treat this list as authoritative: do not offer or attempt an integration that is not on it. A line marks the calls that wait for the user's approval: each one shows the user an approval card, and that card is the confirmation. Any other call may run at once.";

const CONNECTED_HEADER = `You are connected to these integrations right now — call each as integration.action (for example contacts.search), and an MCP server's tools through mcp.call. ${CONNECTED_LIST_RULES}`;

/**
 * ADR-0124: in a `code_run` run, a read is a host function of the script, not a direct call. The
 * header states the route rule, not a route: the approval settings can change during the run,
 * and dispatch decides the route of each call (amendment 2026-11-18). The write labels below stay
 * as confirmation hints (ADR-0069).
 */
const CONNECTED_HEADER_CODE_RUN = `You are connected to these integrations right now. Read from them inside system.code_run, where each read tool is an async function with its own name (for example contacts.search) and mcp.read reads an MCP server's tool. Some reads are direct calls: a read that waits for the user's approval (only a direct call shows the approval card), a read that returns file content, and an MCP tool whose read effect or output kind Alfred cannot confirm. A search hit and a refusal name the current route. Call a write directly as integration.action, and an MCP server's write through mcp.call. ${CONNECTED_LIST_RULES}`;

const NO_INTEGRATIONS_TEXT =
  "You have no integrations connected right now. If the user asks about their email, calendar, files, or other connected data, tell them they need to connect it first — never pretend to have access you do not.";

/**
 * A live provider with no curated tool (GitHub, ADR-0125; Calendar, Drive, Docs, and Slides,
 * ADR-0126) gets a line only when it needs reauth. Its MCP connection line names its tools.
 */
export async function buildConnectedSummaryFromAvailability(
  userId: string,
  availability: IntegrationAvailabilitySnapshot,
  allowedIntegrations: readonly IntegrationSlug[],
  context: ToolRunContext,
): Promise<string> {
  const scriptReads = context.readPath === "code_run";
  // A `code_run` run hides its read tools, but the script still calls them by these names. So
  // the list uses the direct view of the same run, and the header says where a read runs.
  const { readPath: _readPath, ...directView } = context;

  const availableByIntegration = availableToolNamesByIntegration({
    availability,
    allowedIntegrations,
    context: directView,
  });

  const allowed = new Set(allowedIntegrations);
  const lines: string[] = [];

  for (const entry of LIVE_PROVIDERS) {
    if (allowed.size > 0 && !allowed.has(entry.slug)) continue;
    const access = availability.integrations.get(entry.slug);

    if (!access || access.health === null) continue;
    // Full tool names: with bare actions, the boss called `calendar` with an `action` argument.
    const tools = availableByIntegration.get(entry.slug) ?? [];

    // Credentials but no usable tools means reauth. A narrower scope can still allow some tools.
    if (tools.length === 0 && access.health === "needs_reauth") {
      lines.push(
        `- ${entry.slug} — ${entry.summaryBlurb} (needs reauth — tell the user to reconnect ${entry.slug}; don't call its tools yet)`,
      );
      continue;
    }

    if (tools.length > 0) {
      // In a `code_run` run, only the writes get a label: a run-start label on a read would
      // pick its route (ADR-0124 amendment 2026-11-18). Dispatch decides the route of each read.
      const approval = scriptReads
        ? await approvalLabel(
            userId,
            tools.filter((name) => !isDeclaredScriptRead(name)),
            "direct call",
          )
        : await approvalLabel(userId, tools, "call");

      const suffix = approval ? `. ${approval}` : "";
      lines.push(`- ${tools.join(", ")} — ${entry.summaryBlurb}${suffix}`);
    }
  }

  if (availableByIntegration.get("mcp")?.includes("mcp.call")) {
    // The same scope as discovery and the broker, so the list names only reachable servers.
    const scope = await mcpServerIdsAdmittedBy(userId, allowedIntegrations);
    lines.push(...(await mcpConnectionLines(userId, scope, scriptReads)));
  }

  if (lines.length === 0) return NO_INTEGRATIONS_TEXT;

  return [scriptReads ? CONNECTED_HEADER_CODE_RUN : CONNECTED_HEADER, ...lines].join("\n");
}

/**
 * Marks only the calls that always wait, so the label never claims a call runs at once: a
 * dynamic tier can still gate one (ADR-0088). Names the smaller group to save tokens. MCP lines
 * get no label, because `mcp.call` resolves its tier per remote tool.
 */
async function approvalLabel(
  userId: string,
  tools: readonly ToolName[],
  noun: "call" | "direct call",
): Promise<string | null> {
  const modes = await Promise.all(
    tools.map(async (name) => ({ name, mode: await resolvePolicyMode(userId, name) })),
  );

  const waits: ToolName[] = [];
  const others: ToolName[] = [];

  for (const { name, mode } of modes) {
    (toolAlwaysWaitsForApproval(name, mode) ? waits : others).push(name);
  }

  if (waits.length === 0) return null;

  if (others.length === 0) return `Every ${noun} waits for the user's approval.`;

  return waits.length <= others.length
    ? `These wait for the user's approval: ${waits.join(", ")}.`
    : `Every ${noun} waits for the user's approval except ${others.join(", ")}.`;
}

/**
 * One line per MCP connection. The curated registry does not list them, so without these
 * lines the header told the model that a connected server such as Railway did not exist.
 * `scope` is required: the header calls the list authoritative, so a server outside the run's
 * integrations must not appear.
 */
async function mcpConnectionLines(
  userId: string,
  scope: McpServerScope,
  scriptReads: boolean,
): Promise<string[]> {
  const lines: string[] = [];

  const howToCall = scriptReads
    ? "find one with system.search_tools, or with mcp.list_tools inside system.code_run, scoped to this connectionId. A search hit names its current route: system.code_run with mcp.read for a read that runs in a script, or mcp.call for a direct call"
    : "find one with system.search_tools or mcp.list_tools scoped to this connectionId, then call it through mcp.call";

  for (const connection of await listOwnedConnections(userId)) {
    if (!mcpScopeAdmits(scope, connection.serverId)) continue;

    const name = `${JSON.stringify(connection.label)} MCP server (connectionId ${connection.id})`;

    if (connection.status === "auth_required") {
      lines.push(
        `- ${name} (needs reauth — tell the user to reconnect it in Settings; don't call its tools yet)`,
      );
      continue;
    }

    if (!connection.toolCount) continue;

    // No route from the run-start policy (ADR-0124 amendment 2026-11-18): search quotes the
    // route of each hit, and dispatch decides it for each call.
    lines.push(`- ${name} — ${connection.toolCount} tools; ${howToCall}`);
  }

  return lines;
}
