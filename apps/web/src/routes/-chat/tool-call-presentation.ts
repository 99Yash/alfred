import { toolLabel } from "@alfred/contracts";
import { Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { type IntegrationBrand } from "~/lib/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations";
import { parseJsonRecord } from "~/lib/json-record";

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
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

  if (tool.toolName === "system.load_integration") {
    // argsPreview carries the slug live; on reload only resultPreview
    // (`{"ok":true,"slug":"github"}`) is persisted, so fall back to it.
    const result = parseJsonRecord(tool.resultPreview);
    const target = asString(args?.slug) ?? asString(result?.slug);
    const provider = target ? getIntegrationProvider(target) : undefined;
    const name = provider?.name ?? "integration";
    return {
      brand: provider?.brand,
      fallbackIcon: Wrench,
      running: `Connecting to ${name}`,
      done: `Connected to ${name}`,
      failed: `Couldn't connect to ${name}`,
    };
  }

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

  // Integration-scoped tool, e.g. `github.search_pull_requests`.
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
