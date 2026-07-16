import { toolLabel } from "@alfred/contracts";
import { Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations/integrations";
import { parseJsonRecord } from "~/lib/json-record";

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean;
  /** Narration segment this call follows — orders it against the narration trail. */
  segmentIndex?: number;
}

export interface ToolPresentation {
  brand?: IntegrationBrand;
  fallbackIcon: LucideIcon;
  /** Label shown while the call is in flight. */
  running: string;
  /** Label shown once it lands. */
  done: string;
  /** Label shown when the call fails. Falls back to `${done} failed`. */
  failed?: string;
  /** Human-readable secondary line (brief, target, etc.) — not raw JSON. */
  detail?: string;
}

/**
 * Fallback for a tool not in the co-located registry (e.g. a future or
 * web-scoped tool): `"google_calendar.list_events"` → `"list events"`.
 */
function humanizeTool(toolName: string): string {
  const last = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  return last.replace(/_/g, " ");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** What a tool *did*, for the run summary. */
export type ToolCategory = "source" | "action" | "system";

// Read-ish verbs gather context; write-ish verbs change the world. Keyed off
// the leading verb of the tool's action segment (`gmail.send_draft` → "send").
const SOURCE_VERBS = new Set([
  "search",
  "read",
  "list",
  "get",
  "check",
  "open",
  "fetch",
  "view",
  "export",
  "download",
]);
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
 * Classify a tool for the group headline: `"source"` (gathered information),
 * `"action"` (changed something), or `"system"` (plumbing like connecting an
 * integration or spawning a sub-agent — excluded from the "searched / did" tally
 * so it never inflates the count). Pure name-based heuristic; the verb registry
 * carries no category field, so this is the one place that judgment lives.
 */
export function toolCategory(toolName: string): ToolCategory {
  if (toolName === "system.spawn_sub_agent") {
    return "system";
  }
  if (toolName === "system.web_search") return "source";
  const last = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  const verb = last.split("_")[0] ?? "";
  if (ACTION_VERBS.has(verb)) return "action";
  if (SOURCE_VERBS.has(verb)) return "source";
  // Unknown verb: treat as a source so a stray read never reads as a write.
  return "source";
}

/**
 * Turn a raw tool call into something a person can read: the integration's
 * own logo instead of a generic wrench, a present-tense phrase instead of a
 * snake_case symbol, and the meaningful argument (brief, integration name)
 * instead of a `{"slug":"…"}` blob.
 */
export function presentTool(tool: ToolCallView): ToolPresentation {
  const args = parseJsonRecord(tool.argsPreview);
  const slug = tool.toolName.includes(".")
    ? tool.toolName.slice(0, tool.toolName.indexOf("."))
    : "";

  if (tool.toolName === "system.spawn_sub_agent") {
    const allowed = Array.isArray(args?.allowedIntegrations)
      ? (args.allowedIntegrations as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const provider = allowed[0] ? getIntegrationProvider(allowed[0]) : undefined;
    return {
      brand: provider?.brand,
      fallbackIcon: Sparkles,
      running: "Delegating a sub-task",
      done: "Delegated a sub-task",
      failed: "Couldn't delegate a sub-task",
      detail: asString(args?.brief),
    };
  }

  // Every registered tool gets its verbs from the co-located registry; the
  // fallback only fires for an unregistered name (e.g. a web-scoped tool).
  const label = toolLabel(tool.toolName);
  const failed = label ? `Couldn't ${label.title}` : undefined;

  if (slug === "system" || slug === "") {
    if (label) return { fallbackIcon: Wrench, running: label.running, done: label.done, failed };
    const verb = humanizeTool(tool.toolName);
    return { fallbackIcon: Wrench, running: verb, done: verb, failed: `Couldn't ${verb}` };
  }

  // Integration-scoped tool, e.g. `github.search`.
  const provider = getIntegrationProvider(slug);
  const brand = provider?.brand ?? (slug === "web" ? "web" : undefined);
  if (label) {
    return {
      brand,
      fallbackIcon: Wrench,
      running: label.running,
      done: label.done,
      failed,
      detail: provider?.name,
    };
  }
  const verb = humanizeTool(tool.toolName);
  return {
    brand,
    fallbackIcon: Wrench,
    running: verb,
    done: verb,
    failed: `Couldn't ${verb}`,
    detail: provider?.name,
  };
}
