import { useAutoAnimate } from "@formkit/auto-animate/react";
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { SubAgentTrail } from "~/lib/chat/chat-stream-state";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { animatedToolIcon, RunningToolIcon } from "./animated-tool-icons";
import { Elapsed } from "./elapsed";
import { RunGlyphCluster } from "./run-glyph-cluster";
import { runGlyphs, runSummary } from "./run-summary";
import { ToolCallCard } from "./tool-call-card";
import { presentTool, type ToolCallView } from "./tool-call-presentation";

const ITEM = "subagent";

/**
 * A spawned sub-agent, as a container rather than a dead end.
 *
 * A `system.spawn_sub_agent` card used to say "Delegating a sub-task" and then
 * nothing — the child could burn a dozen tool calls and a minute of wall time
 * completely invisibly, and the next thing the user saw was the boss answering.
 * This makes the card the child's own activity trail: its steps stream in
 * nested underneath while it works, with the clock running, and it collapses to
 * one narrative line once the child lands.
 *
 * The trail is live-only. Nothing here is persisted with the assistant message
 * (the child's calls are not the parent's tool-call log), so on reload this
 * falls back to the plain spawn card — the same thing you saw before.
 */
export function SubAgentCard({ tool, trail }: { tool: ToolCallView; trail: SubAgentTrail }) {
  const contentId = useId();
  // Auto-animate insertions so each of the child's steps slides into place as
  // it arrives, matching how the parent trail grows.
  const [stepsRef] = useAutoAnimate<HTMLDivElement>();

  // Live covers both working and parked; only a terminal outcome ends the trail.
  const live = trail.outcome === null;
  const running = live && !trail.waiting;
  // Open while the child is live so its steps stream into view; collapse to the
  // summary when it lands. Re-asserted during render (not in an effect) to
  // avoid a flash, and the user can still toggle freely between transitions.
  const [value, setValue] = useState(live ? ITEM : "");
  const [prevLive, setPrevLive] = useState(live);
  if (prevLive !== live) {
    setPrevLive(live);
    setValue(live ? ITEM : "");
  }

  const steps = trail.tools;
  const spawn = presentTool(tool);
  const brief = asString(parseJsonRecord(tool.argsPreview)?.brief);
  // `cancelled` is not a failure the user caused, but it is still "this did not
  // deliver what it was asked for" — both read as the child not finishing.
  const failed = trail.outcome === "failed" || trail.outcome === "cancelled";

  const headline = running
    ? spawn.running
    : // Parked: usually on an approval, sometimes on a signal. Either way the
      // clock from here is not the agent working, so don't say that it is.
      trail.waiting
      ? "Waiting to continue"
      : failed
        ? "Sub-task didn't finish"
        : // The child's own steps describe the work better than "Delegated a
          // sub-task" does; fall back to the spawn label when it did no tool work.
          steps.length > 0
          ? runSummary(steps)
          : spawn.done;

  const spawnIcon = animatedToolIcon(tool.toolName);
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
              // The spawn tool's own mark on a glowing coin — the eye lands on
              // the delegation while it is the live thing. It stops spinning
              // while the child is parked: nothing is turning over.
              <span
                aria-hidden
                className="chat-node-glow inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)"
              >
                {spawnIcon ? (
                  <RunningToolIcon icon={spawnIcon.Icon} running={running} size={13} />
                ) : (
                  <spawn.fallbackIcon size={13} />
                )}
              </span>
            ) : (
              // Landed: show which services the child actually touched, same
              // vocabulary as a finished top-level run.
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
            {/* What the child was actually asked to do — the one piece of
             * context that makes its steps legible. */}
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
                // "Finished without calling any tools" would be a lie for a
                // child whose only call bounced: the card was drawn, then
                // retracted. This is true either way.
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
