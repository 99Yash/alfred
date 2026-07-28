import { useAutoAnimate } from "@formkit/auto-animate/react";
import * as Accordion from "@radix-ui/react-accordion";
import { AWAIT_SUB_AGENT_TOOL, SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";
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

const ITEM = "tools";

const NO_SUB_AGENTS: readonly SubAgentTrail[] = [];

/** A closed narration segment — the brief line the model wrote before a tool step. */
export interface TrailNarration {
  index: number;
  text: string;
}

const EMPTY_NARRATION: readonly TrailNarration[] = [];

type TrailItem =
  | { kind: "narration"; key: string; text: string }
  // One row per *run* of identical calls: a `gmail.search` and a follow-up
  // `gmail.search` collapse into one card with a `2×` badge, so a turn that
  // pages the same source a few times doesn't read as N near-identical rows.
  // Grouped on (toolName, status) so a failure never hides under a success's
  // count — a fail then a retry-success stay two distinct rows.
  | { kind: "tool"; key: string; tools: ToolCallView[] };

/**
 * Weave the model's narration lines and its tool calls into one ordered trail.
 * Both carry a `segmentIndex`: segment N's narration precedes the tools the
 * model called in step N. Within a segment, the narration line comes first,
 * then its tools in arrival order — mirroring how the turn actually streamed.
 * Consecutive calls to the same tool with the same status fold into one row
 * (carrying every call) so repeated reads collapse to a single badged card;
 * narration or a different tool/status between them breaks the run.
 */
function buildTrail(tools: ToolCallView[], narration: readonly TrailNarration[]): TrailItem[] {
  const toolsBySegment = new Map<number, ToolCallView[]>();
  for (const tool of tools) {
    const seg = tool.segmentIndex ?? 0;
    const list = toolsBySegment.get(seg) ?? [];
    list.push(tool);
    toolsBySegment.set(seg, list);
  }
  const narrationBySegment = new Map<number, string>();
  for (const segment of narration) narrationBySegment.set(segment.index, segment.text);

  const segments = Array.from(
    new Set([...toolsBySegment.keys(), ...narrationBySegment.keys()]),
  ).toSorted((a, b) => a - b);
  const items: TrailItem[] = [];
  for (const seg of segments) {
    const text = narrationBySegment.get(seg);
    if (text && text.trim().length > 0) {
      items.push({ kind: "narration", key: `narration-${seg}`, text });
    }
    for (const tool of toolsBySegment.get(seg) ?? []) {
      const prev = items[items.length - 1];
      const head = prev?.kind === "tool" ? prev.tools[0] : undefined;
      if (
        prev?.kind === "tool" &&
        head &&
        head.toolName === tool.toolName &&
        head.status === tool.status &&
        // Never fold spawns together: each one owns a distinct sub-agent trail,
        // and a folded "2×" row could only ever host one of them.
        tool.toolName !== SPAWN_SUB_AGENT_TOOL
      ) {
        prev.tools.push(tool);
      } else {
        items.push({ kind: "tool", key: tool.toolCallId, tools: [tool] });
      }
    }
  }
  return items;
}

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
 */
export function ToolCallGroup({
  tools,
  active,
  narration = EMPTY_NARRATION,
  subAgents = NO_SUB_AGENTS,
}: {
  tools: ToolCallView[];
  active: boolean;
  narration?: readonly TrailNarration[] | undefined;
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

  if (tools.length === 0) return null;
  if (tools.length === 1 && narration.length === 0) {
    const lone = [tools[0]!];
    const loneTrail = trailFor(lone);
    return loneTrail ? (
      <SubAgentCard tool={lone[0]!} trail={loneTrail} />
    ) : (
      <ToolCallCard tools={lone} />
    );
  }

  const trail = buildTrail(tools, narration);
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
          {/* The trail flows inline in the conversation feed — no capped height
           * or nested scrollbar. The feed's own stick-to-bottom keeps the
           * model's current step in view as the trail grows, so a long agentic
           * run reads as one continuous timeline rather than a cramped box. */}
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
