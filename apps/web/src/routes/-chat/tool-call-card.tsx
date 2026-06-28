import { Check, ChevronRight, Scissors, X } from "lucide-react";
import { useId, useState } from "react";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { animatedToolIcon, RunningToolIcon } from "./animated-tool-icons";
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
export function ToolCallCard({ tools }: { tools: ToolCallView[] }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  // A run of identical calls collapsed into one row (see buildTrail); they
  // share a tool name and status, so the first stands in for the label/glyph
  // and the rest only add to the count and the stacked results below.
  const tool = tools[0]!;
  const count = tools.length;
  const running = tool.status === "started";
  const failed = tool.status === "failed";
  // ADR-0070: the result had non-text bytes stripped before storage, so the
  // preview may be incomplete — flag it instead of letting it look pristine.
  const trimmed = !running && !failed && tools.some((t) => Boolean(t.sanitized));
  const expandable = !running && tools.some((t) => Boolean(t.resultPreview));

  const {
    brand,
    fallbackIcon: FallbackIcon,
    running: runningLabel,
    done,
    failed: failedLabel,
    detail,
  } = presentTool(tool);
  const title = running ? runningLabel : failed ? (failedLabel ?? `${done} failed`) : done;
  // Brandless system tools (web_search, spawn_sub_agent, …) get an animated
  // glyph in place of the flat wrench; brand-scoped tools keep their logo coin.
  const animatedIcon = brand ? undefined : animatedToolIcon(tool.toolName);
  // Inline: always the human "what" (brief / integration). The "why" of a
  // failure goes in the expandable, cleaned up from the raw result JSON.
  const secondary = detail;

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
            {animatedIcon ? (
              <RunningToolIcon icon={animatedIcon.Icon} running={running} size={13} />
            ) : (
              <FallbackIcon size={13} />
            )}
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
        {count > 1 ? (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium tabular-nums",
              failed ? "bg-app-red-2 text-app-red-4" : "bg-app-bg-2 text-app-fg-2",
            )}
            aria-label={`${count} times`}
          >
            {count}×
          </span>
        ) : null}
        {secondary ? (
          <span className="hidden max-w-[45%] min-w-0 truncate text-xs text-app-fg-3 sm:inline">
            {secondary}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {trimmed ? (
            <span
              className="inline-flex items-center text-app-fg-2"
              title="Non-text bytes were stripped from this result before storage; it may be incomplete."
            >
              <Scissors size={12} aria-label="Result trimmed before storage" />
            </span>
          ) : null}
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
        <div id={panelId} className="animate-chat-in mt-1.5 ml-8">
          {trimmed ? (
            <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-app-fg-2">
              <Scissors size={12} aria-hidden />
              Non-text bytes were stripped before storage; this result may be incomplete.
            </p>
          ) : null}
          {/* One block per collapsed call — a single call renders exactly as
              before; a folded run stacks each call's result in arrival order. */}
          {tools.map((t, i) => {
            const text = failed
              ? (failureReason(t.resultPreview) ?? t.resultPreview)
              : t.resultPreview;
            if (!text) return null;
            return (
              <pre
                key={t.toolCallId}
                className={cn(
                  "overflow-x-auto border-l-2 border-app-fg-a1 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap",
                  failed ? "text-app-red-4/90" : "text-app-fg-3",
                  i > 0 && "mt-1.5",
                )}
              >
                {text}
              </pre>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
