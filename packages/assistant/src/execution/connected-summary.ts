import {
  LIVE_PROVIDERS,
  type IntegrationAvailabilitySnapshot,
  type ToolRunContext,
} from "@alfred/contracts";
import { listOwnedConnections } from "@alfred/assistant/connections/mcp";
import { availableToolNamesByIntegration } from "@alfred/assistant/tool-runtime";

/**
 * One line per connected integration for the system prompt (ADR-0053). Grounding only;
 * the dispatcher enforces access. Computed once per run so the prompt prefix stays cache-stable.
 */

const CONNECTED_HEADER =
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events), and an MCP server's tools through mcp.call. Treat this list as authoritative: do not offer or attempt an integration that is not on it.";

const NO_INTEGRATIONS_TEXT =
  "You have no integrations connected right now. If the user asks about their email, calendar, files, or other connected data, tell them they need to connect it first — never pretend to have access you do not.";

/**
 * `identityInSummary` appends the account login, so the boss can resolve `@me` itself (ADR-0071).
 */
export async function buildConnectedSummaryFromAvailability(
  userId: string,
  availability: IntegrationAvailabilitySnapshot,
  allowedIntegrations: readonly string[],
  context: ToolRunContext,
): Promise<string> {
  const availableByIntegration = availableToolNamesByIntegration({
    availability,
    allowedIntegrations,
    context,
  });

  const allowed = new Set(allowedIntegrations);
  const lines: string[] = [];

  for (const entry of LIVE_PROVIDERS) {
    if (allowed.size > 0 && !allowed.has(entry.slug)) continue;
    const access = availability.integrations.get(entry.slug);

    if (!access || access.health === null) continue;
    // Full tool names: with bare actions, the boss called `calendar` with an `action` argument.
    const identity = entry.identityInSummary ? access.accountLabel : null;
    const binding = identity ? ` — connected as ${identity}` : "";
    const tools = availableByIntegration.get(entry.slug) ?? [];

    // Credentials but no usable tools means reauth. A narrower scope can still allow some tools.
    if (tools.length === 0 && access.health === "needs_reauth") {
      lines.push(
        `- ${entry.slug} — ${entry.summaryBlurb}${binding} (needs reauth — tell the user to reconnect ${entry.slug}; don't call its tools yet)`,
      );
      continue;
    }

    if (tools.length > 0) lines.push(`- ${tools.join(", ")} — ${entry.summaryBlurb}${binding}`);
  }

  if (availableByIntegration.get("mcp")?.includes("mcp.call")) {
    lines.push(...(await mcpConnectionLines(userId)));
  }

  if (lines.length === 0) return NO_INTEGRATIONS_TEXT;

  return [CONNECTED_HEADER, ...lines].join("\n");
}

/**
 * One line per MCP connection. The curated registry does not list them, so without these
 * lines the header told the model that a connected server such as Railway MCP did not exist.
 */
async function mcpConnectionLines(userId: string): Promise<string[]> {
  const lines: string[] = [];

  for (const connection of await listOwnedConnections(userId)) {
    const name = `${JSON.stringify(connection.label)} MCP server (connectionId ${connection.id})`;

    if (connection.status === "auth_required") {
      lines.push(
        `- ${name} (needs reauth — tell the user to reconnect it in Settings; don't call its tools yet)`,
      );
      continue;
    }

    if (!connection.toolCount) continue;

    lines.push(
      `- ${name} — ${connection.toolCount} tools; find one with system.search_tools or mcp.list_tools scoped to this connectionId, then call it through mcp.call`,
    );
  }

  return lines;
}
