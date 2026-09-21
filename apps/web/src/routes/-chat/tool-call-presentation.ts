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

/**
 * The second rung of the tool ladder. Its card is the one place a tool name
 * the model chose becomes user-facing copy, so it reads its target out of the
 * call rather than saying "a tool".
 */
const LOAD_TOOL = "system.load_tool" satisfies ToolName;

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /**
   * `preview()` pruned `resultPreview` to fit its cap. A pruned preview still
   * parses, so any reader that re-reads it as the record it came from must
   * check this before trusting the shape (#1018 review, S2).
   */
  resultTruncated?: boolean | undefined;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean | undefined;
  /** Narration segment this call follows — orders it against the narration trail. */
  segmentIndex?: number | undefined;
}

export interface ToolPresentation {
  brand?: IntegrationBrand | undefined;
  fallbackIcon: LucideIcon;
  /** Label shown while the call is in flight. */
  running: string;
  /** Label shown once it lands. */
  done: string;
  /** Label shown when the call fails. Falls back to `${done} failed`. */
  failed?: string | undefined;
  /** Human-readable secondary line (brief, target, etc.) — not raw JSON. */
  detail?: string | undefined;
  /**
   * The successful result is bookkeeping, not evidence — `load_tool` answers
   * `{"ok":true,"name":"github.search"}`, which the row's own copy already
   * states in words. The card hides the expandable panel for such a call, so a
   * run that climbed the tool ladder four times does not offer four dead
   * chevrons. A FAILED call still expands: the reason is real information.
   */
  suppressResult?: boolean | undefined;
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

  // Every registered tool gets its verbs from the co-located registry; the
  // fallback only fires for an unregistered name (e.g. a web-scoped tool).
  const label = toolLabel(tool.toolName);
  const failed = label ? `Couldn't ${label.title}` : undefined;
  // A brandless tool draws its own glyph (see `brandlessToolIcon`); the wrench
  // is the last resort for a name this build does not know.
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
 * The `load_tool` card. Left generic it says "Loaded a tool" beside a wrench,
 * which is the least informative row in a run that may hold four of them — the
 * one fact the user wants is WHICH capability Alfred just reached for, and the
 * call carries it.
 *
 * The target name is read from the args while the turn streams and from the
 * result echo after a reload (`load_tool` returns the name it resolved), so
 * the row keeps its meaning across a refresh. An unresolvable target — a
 * pruned preview, or a name this build's registry does not carry — falls back
 * to the registry's generic copy rather than inventing a target.
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

  // The registry's `title` is an infinitive phrase written for exactly this
  // position ("search issues and pull requests"), so it completes "Ready to…"
  // without a second field of copy per tool.
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
