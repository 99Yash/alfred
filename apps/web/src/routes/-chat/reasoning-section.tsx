import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

const ITEM = "reasoning";

/** "1.2s" under a minute, "1m 4s" beyond — matches the streamed/persisted label. */
function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60)
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}m ${s}s`;
}

/**
 * The model's thinking, in a collapsible "Thinking…" accordion. While the
 * reasoning is still streaming (`active`) the trigger shimmers and the content
 * stays open; once the reply begins it auto-collapses to "Thought for Ns" and
 * becomes a click-to-expand affordance. Mirrors dimension's reasoning section.
 */
export function ReasoningSection({
  reasoning,
  active,
  durationMs,
}: {
  reasoning: string;
  active: boolean;
  durationMs: number | null;
}) {
  // Open while thinking; collapse the moment the reply starts (active → false).
  const [value, setValue] = useState(active ? ITEM : "");
  useEffect(() => {
    if (!active) setValue("");
  }, [active]);

  // While reasoning streams, the capped scroll box would otherwise pin to the
  // top and hide the newest lines — keep it stuck to the bottom so the live
  // thinking stays in view.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const el = contentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, active]);

  if (reasoning.trim().length === 0 && !active) return null;

  return (
    <Accordion.Root
      type="single"
      collapsible
      value={value}
      onValueChange={setValue}
      className="w-full"
    >
      <Accordion.Item value={ITEM}>
        <Accordion.Header>
          <Accordion.Trigger
            disabled={active}
            className={cn(
              "group/reason flex items-center gap-1 text-[13px] outline-none",
              active
                ? "animate-chat-shimmer-mask cursor-default font-medium text-app-fg-4"
                : "text-app-fg-3 transition-colors hover:text-app-fg-4",
            )}
          >
            <span>
              {!active && durationMs != null ? (
                <>
                  <span className="text-app-fg-4">Thought</span> for {formatDuration(durationMs)}
                </>
              ) : (
                "Thinking"
              )}
            </span>
            {!active ? (
              <ChevronRight
                size={14}
                className="transition-transform duration-200 group-data-[state=open]/reason:rotate-90"
              />
            ) : null}
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content className="overflow-hidden data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down">
          <div
            ref={contentRef}
            className={cn(
              "mt-1.5 max-h-72 overflow-y-auto overscroll-contain border-l-2 border-app-fg-a1 pl-3 pr-1 text-[13px] leading-relaxed text-app-fg-3",
              "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
              "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4",
              "[&_code]:rounded [&_code]:bg-app-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]",
              "[&_strong]:font-semibold [&_strong]:text-app-fg-4",
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{reasoning}</ReactMarkdown>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}
