import { useAutoAnimate } from "@formkit/auto-animate/react";
import * as Accordion from "@radix-ui/react-accordion";
import { AWAIT_SUB_AGENT_TOOL, SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";
import type { SyncedChatNarration } from "@alfred/sync";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { SubAgentTrail } from "~/lib/chat/chat-stream-state";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { ChatProse } from "./chat-prose";
import { RunGlyphCluster } from "./run-glyph-cluster";
import { runGlyphs, runSummary } from "./run-summary";
import { SubAgentCard } from "./sub-agent-card";
import { ToolCallCard } from "./tool-call-card";
import { presentTool, type ToolCallView } from "./tool-call-presentation";
import { buildTrail } from "./trail";

const ITEM = "tools";

const NO_SUB_AGENTS: readonly SubAgentTrail[] = [];

/**
 * A turn's tool calls and the model's narration, woven into one collapsible
 * activity trail so a long agentic sequence doesn't bury the reply under a
 * wall of steps. While the turn runs the trail auto-expands — the model's
 * narration lines and tool cards appear interleaved as they stream, the
 * current step glowing — so the user watches Alfred work. Once it lands the
 * trail collapses to a quiet narrative summary ("Checked your calendar and
 * sent a Gmail draft") with the integration glyphs touched alongside;
 * re-expanding replays the full interleaved timeline. A lone tool with no
 * narration skips the wrapper — there's nothing to summarize.
 *
 * Total over `(tools, narration)`: `buildTrail` alone decides whether there is
 * anything to draw. A step whose cards all bounced leaves closed prose with
 * zero cards, so a `tools.length` gate anywhere upstream silently eats prose
 * the user already read. `narration` is required for that reason — omitting it
 * would be the same defect by omission — but "no caller gates on either
 * channel" is a convention held by the two call sites, not by this signature.
 */
export function ToolCallGroup({
  tools,
  active,
  narration,
  subAgents = NO_SUB_AGENTS,
}: {
  tools: ToolCallView[];
  active: boolean;
  /**
   * Every narration segment the turn has closed. Required, not optional: the
   * bug this component exists to avoid is a caller dropping this channel, and
   * an optional prop lets that happen silently. Pass `[]` when there is none —
   * a persisted turn's `narration` is nullable.
   */
  narration: readonly SyncedChatNarration[];
  /**
   * Live trails for sub-agents spawned this turn. Each is hosted by the
   * `spawn_sub_agent` card whose `toolCallId` it names, turning that card from
   * a dead end into the child's own activity trail. Empty on a reloaded turn.
   */
  subAgents?: readonly SubAgentTrail[] | undefined;
}) {
  const contentId = useId();
  // Auto-animate the trail's height/insertions: as tool cards and narration
  // rows stream in during a turn, the container grows smoothly and each new row
  // slides into place instead of the whole trail jumping. auto-animate owns the
  // enter/move animation here (the cards drop their own `animate-chat-in` via
  // `inTrail`), and it self-disables under prefers-reduced-motion.
  const [trailRef] = useAutoAnimate<HTMLDivElement>();
  // Open while the turn runs so narration + tools stream into view; collapse to
  // the summary once it finishes. Re-asserting on the active transition during
  // render (rather than in an effect) avoids a flash and lets the user still
  // toggle freely between transitions.
  const [value, setValue] = useState(active ? ITEM : "");
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    setValue(active ? ITEM : "");
  }

  const trailFor = (item: ToolCallView[]): SubAgentTrail | undefined =>
    item.length === 1 && item[0]!.toolName === SPAWN_SUB_AGENT_TOOL
      ? subAgents.find((s) => s.parentToolCallId === item[0]!.toolCallId)
      : undefined;

  /**
   * The boss's `await_sub_agent` call for a child whose trail is already on
   * screen. One delegation would otherwise draw two rows a line apart — the
   * container reporting the child's live state, and beneath it a card that says
   * the same thing with less detail. The await card still renders whenever
   * there is no trail to defer to (a background parent, or a child that never
   * published a step), so the wait is never invisible. It stays in `tools`
   * either way, so the group headline can still say "Waiting on a sub-task".
   */
  const isRedundantAwait = (item: ToolCallView[]): boolean => {
    if (item.length !== 1 || item[0]!.toolName !== AWAIT_SUB_AGENT_TOOL) return false;
    const childRunId = asString(parseJsonRecord(item[0]!.argsPreview)?.childRunId);
    return childRunId !== undefined && subAgents.some((s) => s.childRunId === childRunId);
  };

  const trail = buildTrail(tools, narration);
  if (trail.length === 0) return null;

  const only = trail.length === 1 ? trail[0]! : undefined;
  if (only?.kind === "tool" && only.tools.length === 1) {
    const loneTrail = trailFor(only.tools);
    return loneTrail ? (
      <SubAgentCard tool={only.tools[0]!} trail={loneTrail} />
    ) : (
      <ToolCallCard tools={only.tools} />
    );
  }

  // The trail flows inline in the conversation feed — no capped height or
  // nested scrollbar. The feed's own stick-to-bottom keeps the model's current
  // step in view as the trail grows, so a long agentic run reads as one
  // continuous timeline rather than a cramped box. Shared by both drawing
  // branches below; `useAutoAnimate`'s ref attaches to whichever renders.
  const rail = (
    <div
      ref={trailRef}
      className="mt-1.5 ml-3 flex flex-col gap-1.5 border-l-2 border-app-fg-a1 pl-3"
    >
      {trail.map((item) => {
        if (item.kind !== "tool") return <NarrationRow key={item.key} text={item.text} />;
        if (isRedundantAwait(item.tools)) return null;
        const subAgent = trailFor(item.tools);
        return subAgent ? (
          <SubAgentCard key={item.key} tool={item.tools[0]!} trail={subAgent} />
        ) : (
          <ToolCallCard key={item.key} tools={item.tools} inTrail />
        );
      })}
    </div>
  );

  // Prose with no cards — a step whose calls all bounced, or narration that
  // arrived before its tools did. There is nothing to summarize behind a
  // chevron and no last tool to headline with, so the rows stand on their own.
  // This returns *before* any `tools[…]!` read below, which empty `tools`
  // cannot survive.
  if (!trail.some((item) => item.kind === "tool")) {
    return <div className="animate-chat-in w-full">{rail}</div>;
  }

  const last = tools[tools.length - 1]!;
  const runningLabel = last.status === "started" ? presentTool(last).running : "Working on it";
  const anyFailed = tools.some((t) => t.status === "failed");
  const glyphs = runGlyphs(tools);

  return (
    <Accordion.Root
      type="single"
      collapsible
      value={value}
      onValueChange={setValue}
      className="animate-chat-in w-full"
    >
      <Accordion.Item value={ITEM}>
        <Accordion.Header>
          <Accordion.Trigger
            aria-controls={contentId}
            className={cn(
              "group/tools -mx-2 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px]",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-2",
            )}
          >
            {active ? (
              <span aria-hidden className="chat-think-mark inline-flex shrink-0">
                <img
                  src="/images/logo/alfred-logo.svg"
                  alt=""
                  className="size-[18px] rounded-[5px]"
                />
              </span>
            ) : (
              <RunGlyphCluster glyphs={glyphs} />
            )}
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                active ? "animate-chat-shimmer-mask text-app-fg-4" : "text-app-fg-4",
              )}
            >
              {active ? runningLabel : runSummary(tools)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {!active && anyFailed ? (
                <>
                  <span className="sr-only">Some steps failed</span>
                  <span aria-hidden className="size-1.5 rounded-full bg-app-red-4" />
                </>
              ) : null}
              <ChevronRight
                size={14}
                aria-hidden
                className="text-app-fg-2 transition-[transform,color] duration-200 group-hover/tools:text-app-fg-4 group-data-[state=open]/tools:rotate-90"
              />
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content
          id={contentId}
          className="data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down overflow-hidden"
        >
          {rail}
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}

/**
 * The model's narration line for a step — a quiet, muted node sitting between
 * the tool cards in the trail. A small dot marks it (vs. the tool cards' logo
 * glyphs) so the eye reads it as a thought, not an action; the prose stays
 * subordinate to the final reply below.
 */
function NarrationRow({ text }: { text: string }) {
  return (
    // No `animate-chat-in` here — the trail's `useAutoAnimate` owns this row's
    // enter/move animation (see `ToolCallGroup`); the two would fight otherwise.
    <div className="flex items-start gap-2">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-app-fg-2" />
      </span>
      <ChatProse className="min-w-0 flex-1 py-0.5">{text}</ChatProse>
    </div>
  );
}
