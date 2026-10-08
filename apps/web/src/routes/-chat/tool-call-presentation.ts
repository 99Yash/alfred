import {
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

/** Its card names the tool the model loaded, read from the call. */
const LOAD_TOOL = "system.load_tool" satisfies ToolName;

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
  fallbackIcon: LucideIcon;
  running: string;
  done: string;
  /** Falls back to `${done} failed`. */
  failed?: string | undefined;
  /** Readable secondary line, not raw JSON. */
  detail?: string | undefined;
  /**
   * The result is bookkeeping, not evidence (`load_tool` returns `{"ok":true,…}`), so hide the panel.
   * A failed call still expands.
   */
  suppressResult?: boolean | undefined;
}

/** `"google_calendar.list_events"` → `"list_events"`. */
function actionSegment(toolName: string): string {
  return toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
}

/** For a tool not in the registry: `"google_calendar.list_events"` → `"list events"`. */
function humanizeTool(toolName: string): string {
  return actionSegment(toolName).replace(/_/g, " ");
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

/** A readable tool call: integration logo, present-tense phrase, and the meaningful argument. */
export function presentTool(tool: ToolCallView): ToolPresentation {
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

  if (tool.toolName === LOAD_TOOL) return presentLoadTool(tool, fallbackIcon);

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

/**
 * The `load_tool` card names which capability Alfred loaded.
 * The name comes from the args while streaming and the result echo after reload.
 * If neither resolves, use the registry's generic copy.
 */
function presentLoadTool(tool: ToolCallView, fallbackIcon: LucideIcon): ToolPresentation {
  const args = parseJsonRecord(tool.argsPreview);
  const result = parseJsonRecord(tool.resultPreview);
  const target = asString(args?.name) ?? asString(result?.name);
  const generic = toolLabel(tool.toolName);
  const targetLabel = target ? toolLabel(target) : null;

  const provider = target?.includes(".")
    ? getIntegrationPage(target.slice(0, target.indexOf(".")))
    : undefined;

  if (!targetLabel) {
    return {
      brand: provider?.brand,
      fallbackIcon,
      running: generic?.running ?? "Loading a tool",
      done: generic?.done ?? "Loaded a tool",
      failed: "Couldn't load that tool",
      detail: provider?.name,
      suppressResult: true,
    };
  }

  // The registry `title` is an infinitive phrase, so it completes "Ready to…".
  return {
    brand: provider?.brand,
    fallbackIcon,
    running: `Loading the tool to ${targetLabel.title}`,
    done: `Ready to ${targetLabel.title}`,
    failed: `Couldn't load the tool to ${targetLabel.title}`,
    detail: provider?.name,
    suppressResult: true,
  };
}
