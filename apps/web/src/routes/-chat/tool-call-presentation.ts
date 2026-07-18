import { type ToolCategory, toolCategoryOf, toolLabel } from "@alfred/contracts";
import { Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations/integrations";
import { asString, parseJsonRecord } from "~/lib/json-record";

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

/** The tool's action segment: `"google_calendar.list_events"` → `"list_events"`. */
function actionSegment(toolName: string): string {
  return toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
}

/**
 * Fallback for a tool not in the co-located registry (e.g. a future or
 * web-scoped tool): `"google_calendar.list_events"` → `"list events"`.
 */
function humanizeTool(toolName: string): string {
  return actionSegment(toolName).replace(/_/g, " ");
}

export type { ToolCategory };

// Verbs that change the world. Anything else — a read verb, or a verb we don't
// recognize — is treated as a source, so a stray read never miscounts as a
// write. (A matching source-verb list would be redundant: it and the default
// both resolve to `"source"`.)
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
 * `"action"` (changed something), or `"system"` (plumbing like loading a tool
 * or spawning a sub-agent — excluded from the "searched / did" tally so it never
 * inflates the count). The registry ({@link toolCategoryOf}) is the source of
 * truth; the leading-verb guess only covers an unregistered name.
 */
export function toolCategory(toolName: string): ToolCategory {
  return (
    toolCategoryOf(toolName) ??
    (ACTION_VERBS.has(actionSegment(toolName).split("_")[0] ?? "") ? "action" : "source")
  );
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
