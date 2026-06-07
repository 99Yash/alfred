import { Check, Loader2, Sparkles, Wrench, X, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { getIntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
}

/** "google_calendar.list_events" → "list events" (the verb the user cares about). */
function humanizeTool(toolName: string): string {
  const last = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  return last.replace(/_/g, " ");
}

/** Best-effort parse of the server-stringified args/result preview. */
function parsePreview(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Friendly, present-tense verb phrases for the system meta-tools. */
const SYSTEM_TOOL_LABELS: Record<string, { running: string; done: string }> = {
  read_scratch: { running: "Reading notes", done: "Read notes" },
  write_scratch: { running: "Saving notes", done: "Saved notes" },
  promote: { running: "Recording a finding", done: "Recorded a finding" },
  suggest_todo: { running: "Suggesting a to-do", done: "Suggested a to-do" },
};

interface ToolPresentation {
  brand?: IntegrationBrand;
  fallbackIcon: LucideIcon;
  /** Label shown while the call is in flight. */
  running: string;
  /** Label shown once it lands. */
  done: string;
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
  const args = parsePreview(tool.argsPreview);
  const slug = tool.toolName.includes(".") ? tool.toolName.slice(0, tool.toolName.indexOf(".")) : "";

  if (tool.toolName === "system.load_integration") {
    // argsPreview carries the slug live; on reload only resultPreview
    // (`{"ok":true,"slug":"github"}`) is persisted, so fall back to it.
    const result = parsePreview(tool.resultPreview);
    const target = asString(args?.slug) ?? asString(result?.slug);
    const provider = target ? getIntegrationProvider(target) : undefined;
    const name = provider?.name ?? "integration";
    return {
      brand: provider?.brand,
      fallbackIcon: Wrench,
      running: `Connecting to ${name}`,
      done: `Connected to ${name}`,
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
      detail: asString(args?.brief),
    };
  }

  if (slug === "system" || slug === "") {
    const action = tool.toolName.includes(".")
      ? tool.toolName.slice(tool.toolName.indexOf(".") + 1)
      : tool.toolName;
    const known = SYSTEM_TOOL_LABELS[action];
    if (known) return { fallbackIcon: Wrench, running: known.running, done: known.done };
    const verb = humanizeTool(tool.toolName);
    return { fallbackIcon: Wrench, running: verb, done: verb };
  }

  // Integration-scoped tool, e.g. `github.list_pull_requests`.
  const provider = getIntegrationProvider(slug);
  const verb = humanizeTool(tool.toolName);
  return {
    brand: provider?.brand ?? (slug === "web" ? "web" : undefined),
    fallbackIcon: Wrench,
    running: verb,
    done: verb,
    detail: provider?.name,
  };
}

/** Pull a clean reason out of a failed tool's result preview. */
function failureReason(resultPreview: string | undefined): string | undefined {
  const parsed = parsePreview(resultPreview);
  if (!parsed) return resultPreview;
  const error = parsed.error;
  if (error && typeof error === "object") {
    const message = asString((error as Record<string, unknown>).message);
    if (message) return message;
  }
  return asString(parsed.message) ?? asString(parsed.error) ?? resultPreview;
}

/**
 * A single tool call surfaced as a live card. Shimmers while running, settles
 * to a check (or error) with an expandable result preview when it lands. The
 * leading glyph is the integration's own logo whenever the tool belongs to
 * one, so the user can see at a glance which service Alfred is touching.
 */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const running = tool.status === "started";
  const failed = tool.status === "failed";
  const expandable = !running && Boolean(tool.resultPreview);

  const { brand, fallbackIcon: FallbackIcon, running: runningLabel, done, detail } =
    presentTool(tool);
  const title = running ? runningLabel : failed ? `${done} failed` : done;
  // Inline: always the human "what" (brief / integration). The "why" of a
  // failure goes in the expandable, cleaned up from the raw result JSON.
  const secondary = detail;
  const panelText = failed ? (failureReason(tool.resultPreview) ?? tool.resultPreview) : tool.resultPreview;

  return (
    <div className="animate-chat-in rounded-xl border border-app-fg-a1/50 bg-app-bg-2/60 text-[13px]">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          expandable && "cursor-pointer rounded-xl hover:bg-app-bg-a2",
        )}
      >
        <span
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-md",
            running && "bg-app-purple-2/15 text-app-purple-4",
            !running && !failed && "bg-app-green-2/15 text-app-green-4",
            failed && "bg-app-red-2/15 text-app-red-4",
          )}
        >
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : failed ? (
            <X size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
        {brand ? (
          <IntegrationGlyph brand={brand} size={14} className="shrink-0" />
        ) : (
          <FallbackIcon size={12} className="shrink-0 text-app-fg-3" />
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            running ? "animate-chat-shimmer text-app-fg-3" : failed ? "text-app-red-4" : "text-app-fg-4",
          )}
        >
          {running ? `${title}…` : title}
        </span>
        {secondary ? (
          <span className="ml-auto min-w-0 max-w-[55%] truncate text-right text-app-fg-3">
            {secondary}
          </span>
        ) : null}
      </button>
      {expandable ? (
        <pre
          id={panelId}
          hidden={!open}
          className={cn(
            "animate-chat-in overflow-x-auto whitespace-pre-wrap border-t border-app-fg-a1/40 px-3 py-2 text-[12px]",
            failed ? "text-app-red-4/90" : "text-app-fg-3",
          )}
        >
          {panelText}
        </pre>
      ) : null}
    </div>
  );
}
