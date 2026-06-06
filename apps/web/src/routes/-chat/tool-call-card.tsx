import { Check, Loader2, Wrench, X } from "lucide-react";
import { useId, useState } from "react";
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

/**
 * A single tool call surfaced as a live card. Shimmers while running, settles
 * to a check (or error) with an expandable result preview when it lands.
 */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const label = humanizeTool(tool.toolName);
  const running = tool.status === "started";
  const failed = tool.status === "failed";
  const expandable = !running && Boolean(tool.resultPreview);

  return (
    <div className="animate-chat-in rounded-xl border border-vs-fg-a1/50 bg-vs-bg-2/60 text-[13px]">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          expandable && "cursor-pointer rounded-xl hover:bg-vs-bg-a2",
        )}
      >
        <span
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-md",
            running && "bg-vs-purple-2/15 text-vs-purple-4",
            !running && !failed && "bg-vs-green-2/15 text-vs-green-4",
            failed && "bg-vs-red-2/15 text-vs-red-4",
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
        <Wrench size={12} className="shrink-0 text-vs-fg-3" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            running ? "animate-chat-shimmer text-vs-fg-3" : "text-vs-fg-4",
          )}
        >
          {running ? `Running ${label}…` : failed ? `${label} failed` : label}
        </span>
        {tool.argsPreview ? (
          <span className="hidden max-w-[40%] truncate text-vs-fg-3 sm:inline">
            {tool.argsPreview}
          </span>
        ) : null}
      </button>
      {expandable ? (
        <pre
          id={panelId}
          hidden={!open}
          className="animate-chat-in overflow-x-auto border-t border-vs-fg-a1/40 px-3 py-2 text-[12px] text-vs-fg-3"
        >
          {tool.resultPreview}
        </pre>
      ) : null}
    </div>
  );
}
