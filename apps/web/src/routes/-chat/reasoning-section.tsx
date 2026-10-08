import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { ChatProse } from "./chat-prose";
import { formatDuration } from "./duration";

const ITEM = "reasoning";

// A finished block shows only if it took a beat or has enough text; else it is a "Thought for 0.0s" stub.
const MIN_COMPLETE_MS = 400;

const MIN_COMPLETE_CHARS = 160;

/** Collapsible reasoning. Open and shimmering while active; collapses to "Thought for Ns" when the reply starts. */
export function ReasoningSection({
  reasoning,
  active,
  durationMs,
}: {
  reasoning: string;
  active: boolean;
  durationMs: number | null;
}) {
  // Collapse during render when `active` turns false; an effect would flash the panel for a frame.
  const [value, setValue] = useState(active ? ITEM : "");
  const [prevActive, setPrevActive] = useState(active);

  if (prevActive !== active) {
    setPrevActive(active);

    if (!active) setValue("");
  }

  // Keep the capped box at the bottom while reasoning streams.
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
                // Below the threshold, drop the duration rather than show "for 0.0s".
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
            className="mt-1.5 max-h-72 overflow-y-auto overscroll-contain border-l-2 border-app-fg-a1 pr-1 pl-3"
          >
            <ChatProse>{reasoning}</ChatProse>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}
