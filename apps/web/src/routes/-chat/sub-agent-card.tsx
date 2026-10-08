import { useAutoAnimate } from "@formkit/auto-animate/react";
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { SubAgentTrail } from "~/lib/chat/chat-stream-state";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { brandlessToolIcon, RunningToolIcon } from "./animated-tool-icons";
import { Elapsed } from "./elapsed";
import { RunGlyphCluster } from "./run-glyph-cluster";
import { runGlyphs, runSummary } from "./run-summary";
import { ToolCallCard } from "./tool-call-card";
import { presentTool, type ToolCallView } from "./tool-call-presentation";

const ITEM = "subagent";

/**
 * A spawned sub-agent's card, showing the child's steps nested while it works.
 * Live only: the child's calls are not persisted, so on reload this is the plain spawn card.
 */
export function SubAgentCard({ tool, trail }: { tool: ToolCallView; trail: SubAgentTrail }) {
  const contentId = useId();
  const [stepsRef] = useAutoAnimate<HTMLDivElement>();

  // Live includes parked; only a terminal outcome ends it.
  const live = trail.outcome === null;
  const running = live && !trail.waiting;
  // Open while live, collapse when done. Set during render to avoid a flash.
  const [value, setValue] = useState(live ? ITEM : "");
  const [prevLive, setPrevLive] = useState(live);

  if (prevLive !== live) {
    setPrevLive(live);
    setValue(live ? ITEM : "");
  }

  const steps = trail.tools;
  const spawn = presentTool(tool);
  const brief = asString(parseJsonRecord(tool.argsPreview)?.brief);
  // `cancelled` also means the child did not finish.
  const failed = trail.outcome === "failed" || trail.outcome === "cancelled";

  const headline = running
    ? spawn.running
    : // Parked: the clock is not the agent working.
      trail.waiting
      ? "Waiting to continue"
      : failed
        ? "Sub-task didn't finish"
        : // The child's steps, else the spawn label.
          steps.length > 0
          ? runSummary(steps)
          : spawn.done;

  const SpawnIcon = brandlessToolIcon(tool.toolName);

  const stepCount =
    steps.length > 0 ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : null;

  return (
    <Accordion.Root
      type="single"
      collapsible
      value={value}
      onValueChange={setValue}
      className="w-full text-[13px]"
    >
      <Accordion.Item value={ITEM}>
        <Accordion.Header>
          <Accordion.Trigger
            aria-controls={contentId}
            className={cn(
              "group/subagent -mx-2 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-2",
            )}
          >
            {live ? (
              // Stops spinning while the child is parked.
              <span
                aria-hidden
                className="chat-node-glow inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)"
              >
                {SpawnIcon ? (
                  <RunningToolIcon icon={SpawnIcon} running={running} size={13} />
                ) : (
                  <spawn.fallbackIcon size={13} />
                )}
              </span>
            ) : (
              <RunGlyphCluster glyphs={runGlyphs(steps)} />
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
              {headline}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {stepCount && !live ? (
                <span className="text-[11px] text-app-fg-2">{stepCount}</span>
              ) : null}
              <Elapsed startedTs={trail.startedTs} endedTs={trail.endedTs} />
              <ChevronRight
                size={14}
                aria-hidden
                className="text-app-fg-2 transition-[transform,color] duration-200 group-hover/subagent:text-app-fg-4 group-data-[state=open]/subagent:rotate-90"
              />
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content
          id={contentId}
          className="data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down overflow-hidden"
        >
          <div className="mt-1.5 ml-3 flex flex-col gap-1.5 border-l-2 border-app-fg-a1 pl-3">
            {/* The brief makes the child's steps legible. */}
            {brief ? <p className="text-[12px] text-app-fg-3">{brief}</p> : null}
            <div ref={stepsRef} className="flex flex-col gap-1.5">
              {steps.map((step) => (
                <div key={step.toolCallId} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <ToolCallCard tools={[step]} inTrail />
                  </div>
                  <Elapsed startedTs={step.startedTs} endedTs={step.endedTs} />
                </div>
              ))}
              {steps.length === 0 ? (
                // A child whose only call bounced did call a tool, so do not say it called none.
                <p className="text-[12px] text-app-fg-2">
                  {running ? "Getting started…" : "No steps to show."}
                </p>
              ) : null}
            </div>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}
