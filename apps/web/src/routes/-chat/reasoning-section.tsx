import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

const ITEM = "reasoning";

// A *finished* reasoning block earns a row only if it reflects real thinking:
// either it took a beat or it's long enough to be worth reading. Below both
// thresholds it renders as a useless "Thought for 0.0s" stub (the model emitted
// a token or two with no measurable pause), so we drop it entirely.
const MIN_COMPLETE_MS = 400;
const MIN_COMPLETE_CHARS = 160;

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
  // Tracking the previous `active` during render lets us re-assert the collapse
  // on the transition without an effect (an effect would flash the open panel
  // for a frame). The user can still toggle freely between transitions.
  const [value, setValue] = useState(active ? ITEM : "");
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) setValue("");
  }

  // While reasoning streams, the capped scroll box would otherwise pin to the
  // top and hide the newest lines — keep it stuck to the bottom so the live
  // thinking stays in view.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const el = contentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, active]);

  if (!active) {
    const substantive =
      reasoning.trim().length >= MIN_COMPLETE_CHARS ||
      (durationMs != null && durationMs >= MIN_COMPLETE_MS);
    if (!substantive) return null;
  }

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
              {active ? (
                "Thinking"
              ) : durationMs != null && durationMs >= MIN_COMPLETE_MS ? (
                // Only quote a duration we actually measured — a sub-threshold
                // value renders as a silly "for 0.0s", so drop the suffix and
                // keep the bare "Thought" (the content itself is still useful).
                <>
                  <span className="text-app-fg-4">Thought</span> for {formatDuration(durationMs)}
                </>
              ) : (
                <span className="text-app-fg-4">Thought</span>
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
        <Accordion.Content className="data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down overflow-hidden">
          <div
            ref={contentRef}
            className={cn(
              "mt-1.5 max-h-72 overflow-y-auto overscroll-contain border-l-2 border-app-fg-a1 pr-1 pl-3 text-[13px] leading-relaxed text-app-fg-3",
              "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
              "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4",
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
