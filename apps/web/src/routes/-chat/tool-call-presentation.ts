import {
  mcpRemoteToolPhrase,
  SPAWN_SUB_AGENT_TOOL,
  toStringArray,
  type ToolCategory,
  type ToolName,
  toolCategoryOf,
  toolLabel,
} from "@alfred/contracts";
import { Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { brandlessToolIcon } from "./animated-tool-icons";
import { MCP_CALL_TOOL, type McpServerLookup } from "./mcp-server";

/**
 * Plumbing: the model finding and loading its own tools. Not work for the user, so no surface draws it.
 * Read through {@link visibleTools}.
 */
const TRAIL_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "system.search_tools",
  "system.load_tool",
] satisfies ToolName[]);

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /** `preview()` pruned the preview. It still parses, so check this before trusting its shape. */
  resultTruncated?: boolean | undefined;
  /** ADR-0070: non-text bytes were stripped before storage. */
  sanitized?: boolean | undefined;
  /** The narration segment this call follows. */
  segmentIndex?: number | undefined;
}

export interface ToolPresentation {
  brand?: IntegrationBrand | undefined;
  /** A user-added MCP server has no brand artwork, so its row shows the vendor's favicon. */
  faviconDomain?: string | undefined;
  fallbackIcon: LucideIcon;
  running: string;
  done: string;
  /** Falls back to `${done} failed`. */
  failed?: string | undefined;
  /** Readable secondary line, not raw JSON. */
  detail?: string | undefined;
}

/**
 * The calls a person sees. Every surface that draws or counts tool calls reads this, never the raw list.
 * Filter once where the surface receives its list and pass the result down.
 */
export function visibleTools<T extends Pick<ToolCallView, "toolName">>(tools: readonly T[]): T[] {
  return tools.filter((tool) => !TRAIL_HIDDEN_TOOLS.has(tool.toolName));
}

/** `"google_calendar.list_events"` → `"list_events"`. */
function actionSegment(toolName: string): string {
  return toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
}

/** For a tool not in the registry: `"google_calendar.list_events"` → `"list events"`. */
function humanizeTool(toolName: string): string {
  return actionSegment(toolName).replace(/_/g, " ");
}

/** The remote tool an `mcp.call` names. `undefined` when the args preview does not carry both ids. */
function mcpCallTarget(
  argsPreview: string | undefined,
): { connectionId: string; remoteName: string } | undefined {
  const args = parseJsonRecord(argsPreview);
  const connectionId = asString(args?.connectionId);
  const remoteName = asString(args?.remoteName);

  return connectionId && remoteName ? { connectionId, remoteName } : undefined;
}

/**
 * What makes two calls the same operation for a folded row. An `mcp.call` is one tool name for
 * every server, so its target joins the key: two servers or two remote tools never share a row.
 */
export function foldIdentity(tool: Pick<ToolCallView, "toolName" | "argsPreview">): string {
  const target = tool.toolName === MCP_CALL_TOOL ? mcpCallTarget(tool.argsPreview) : undefined;

  return target
    ? `${tool.toolName}\u0000${target.connectionId}\u0000${target.remoteName}`
    : tool.toolName;
}

/** True when any call is an `mcp.call`, so a surface asks for the server list only then. */
export function hasMcpCall(tools: readonly Pick<ToolCallView, "toolName">[]): boolean {
  return tools.some((tool) => tool.toolName === MCP_CALL_TOOL);
}

export type { ToolCategory };

// Verbs that change the world. Anything else counts as a source, so a read never counts as a write.
const ACTION_VERBS = new Set([
  "send",
  "create",
  "update",
  "append",
  "add",
  "write",
  "save",
  "delete",
  "remove",
  "resolve",
  "suggest",
  "promote",
  "remember",
  "batch",
]);

/**
 * `"source"`, `"action"`, or `"system"` (plumbing, left out of the headline tally).
 * The registry ({@link toolCategoryOf}) decides; the verb guess covers unregistered names.
 */
export function toolCategory(toolName: string): ToolCategory {
  return (
    toolCategoryOf(toolName) ??
    (ACTION_VERBS.has(actionSegment(toolName).split("_")[0] ?? "") ? "action" : "source")
  );
}

/**
 * A readable tool call: integration logo, present-tense phrase, and the meaningful argument.
 * `mcpServers` names the server behind an `mcp.call`. Without it the row still names the remote tool.
 */
export function presentTool(tool: ToolCallView, mcpServers?: McpServerLookup): ToolPresentation {
  const args = parseJsonRecord(tool.argsPreview);

  const slug = tool.toolName.includes(".")
    ? tool.toolName.slice(0, tool.toolName.indexOf("."))
    : "";

  if (tool.toolName === SPAWN_SUB_AGENT_TOOL) {
    const allowed = toStringArray(args?.allowedIntegrations);
    const provider = allowed[0] ? getIntegrationPage(allowed[0]) : undefined;

    return {
      brand: provider?.brand,
      fallbackIcon: Sparkles,
      running: "Delegating a sub-task",
      done: "Delegated a sub-task",
      failed: "Couldn't delegate a sub-task",
      detail: asString(args?.brief),
    };
  }

  // The fallback is only for unregistered names.
  const label = toolLabel(tool.toolName);
  const failed = label ? `Couldn't ${label.title}` : undefined;
  // The wrench is for names this build does not know.
  const fallbackIcon = brandlessToolIcon(tool.toolName) ?? Wrench;

  const mcpTarget = tool.toolName === MCP_CALL_TOOL ? mcpCallTarget(tool.argsPreview) : undefined;

  if (mcpTarget) {
    // The remote name is the server's own word for the action, e.g. "list deployments".
    const action = mcpRemoteToolPhrase(mcpTarget.remoteName);
    const server = mcpServers?.(mcpTarget.connectionId);

    return {
      brand: server?.brand,
      faviconDomain: server?.faviconDomain,
      fallbackIcon,
      running: `Running ${action}`,
      done: `Ran ${action}`,
      failed: `Couldn't run ${action}`,
      detail: server?.label,
    };
  }

  if (slug === "system" || slug === "") {
    if (label) return { fallbackIcon, running: label.running, done: label.done, failed };
    const verb = humanizeTool(tool.toolName);

    return { fallbackIcon, running: verb, done: verb, failed: `Couldn't ${verb}` };
  }

  // Integration-scoped tool, e.g. `github.search`.
  const provider = getIntegrationPage(slug);
  const brand = provider?.brand ?? (slug === "web" ? "web" : undefined);

  if (label) {
    return {
      brand,
      fallbackIcon,
      running: label.running,
      done: label.done,
      failed,
      detail: provider?.name,
    };
  }

  const verb = humanizeTool(tool.toolName);

  return {
    brand,
    fallbackIcon,
    running: verb,
    done: verb,
    failed: `Couldn't ${verb}`,
    detail: provider?.name,
  };
}
