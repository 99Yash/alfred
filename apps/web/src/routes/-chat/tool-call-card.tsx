import { Check, ChevronRight, X } from "lucide-react";
import { useId, useState } from "react";
import { IntegrationIcon } from "~/lib/integration-icons";
import { parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { presentTool, type ToolCallView } from "./tool-call-presentation";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
        {brand ? (
          // The integration's own app-icon coin. While in flight an indigo→
          // violet halo drifts behind it (chat-node-glow inherits the tile's
          // radius) so the eye lands on what's happening now.
          <span
            aria-hidden
            className={cn("inline-flex shrink-0 rounded-full", running && "chat-node-glow")}
          >
            <IntegrationIcon brand={brand} size="xs" />
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-[var(--app-shadow-elevated)]",
              running && "chat-node-glow",
            )}
          >
            <FallbackIcon size={13} />
          </span>
        )}
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
