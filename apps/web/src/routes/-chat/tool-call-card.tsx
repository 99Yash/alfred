import { toolLabel } from "@alfred/contracts";
import { Check, ChevronRight, Sparkles, Wrench, X, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations";
import { parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
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

interface ToolPresentation {
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
 * Turn a raw tool call into something a person can read: the integration's
 * own logo instead of a generic wrench, a present-tense phrase instead of a
 * snake_case symbol, and the meaningful argument (brief, integration name)
 * instead of a `{"slug":"…"}` blob.
 */
function presentTool(tool: ToolCallView): ToolPresentation {
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

/** Pull a clean reason out of a failed tool's result preview. */
function failureReason(resultPreview: string | undefined): string | undefined {
  const parsed = parseJsonRecord(resultPreview);
  if (!parsed) return resultPreview;
  const error = parsed.error;
  if (error && typeof error === "object") {
    const message = asString((error as Record<string, unknown>).message);
    if (message) return message;
  }
  return asString(parsed.message) ?? asString(parsed.error) ?? resultPreview;
}

/**
 * A single tool call surfaced inline as a light row — a sibling of the
 * reasoning "Thought" row, not a heavy card. While running, the label sweeps
 * the same shimmer mask as the reasoning trigger; it settles to a quiet check
 * (or red ×) once it lands. Routine tool calls stay visually subordinate to
 * the reply text; the framed treatment is reserved for the approval tray,
 * which actually demands a decision. The leading glyph is the integration's
 * own logo whenever the tool belongs to one, so the user can see at a glance
 * which service Alfred is touching.
 */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const running = tool.status === "started";
  const failed = tool.status === "failed";
  const expandable = !running && Boolean(tool.resultPreview);

  const {
    brand,
    fallbackIcon: FallbackIcon,
    running: runningLabel,
    done,
    failed: failedLabel,
    detail,
  } = presentTool(tool);
  const title = running ? runningLabel : failed ? (failedLabel ?? `${done} failed`) : done;
  // Inline: always the human "what" (brief / integration). The "why" of a
  // failure goes in the expandable, cleaned up from the raw result JSON.
  const secondary = detail;
  const panelText = failed
    ? (failureReason(tool.resultPreview) ?? tool.resultPreview)
    : tool.resultPreview;

  return (
    <div className="animate-chat-in text-[13px]">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "-mx-2 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left",
          "transition-colors duration-150",
          expandable ? "cursor-pointer hover:bg-app-bg-a2" : "cursor-default",
        )}
      >
        <span
          aria-hidden
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-app-bg-2"
        >
          {brand ? (
            <IntegrationGlyph brand={brand} size={14} />
          ) : (
            <FallbackIcon size={13} className="text-app-fg-3" />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-medium",
            running
              ? "animate-chat-shimmer-mask text-app-fg-4"
              : failed
                ? "text-app-red-4"
                : "text-app-fg-4",
          )}
        >
          {title}
        </span>
        {secondary ? (
          <span className="hidden min-w-0 max-w-[45%] truncate text-xs text-app-fg-3 sm:inline">
            {secondary}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {running ? null : failed ? (
            <X size={14} aria-hidden className="text-app-red-4" />
          ) : (
            <Check size={14} aria-hidden className="text-app-green-4" />
          )}
          {expandable ? (
            <ChevronRight
              size={14}
              aria-hidden
              className={cn("text-app-fg-2 transition-transform duration-200", open && "rotate-90")}
            />
          ) : null}
        </span>
      </button>
      {expandable && open ? (
        <pre
          id={panelId}
          className={cn(
            "animate-chat-in ml-8 mt-1.5 overflow-x-auto whitespace-pre-wrap border-l-2 border-app-fg-a1 pl-3 text-[12px] leading-relaxed",
            failed ? "text-app-red-4/90" : "text-app-fg-3",
          )}
        >
          {panelText}
        </pre>
      ) : null}
    </div>
  );
}
