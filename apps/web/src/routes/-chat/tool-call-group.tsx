import { useAutoAnimate } from "@formkit/auto-animate/react";
import * as Accordion from "@radix-ui/react-accordion";
import { AWAIT_SUB_AGENT_TOOL, isQuestionApproval, SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";
import type { SyncedChatNarration } from "@alfred/sync";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { askUserSummary, type AskUserSummary } from "~/components/approvals/ask-user";
import { QuestionAnswersCard } from "~/components/approvals/question-answers-card";
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
 * A settled `system.ask_user` call shows its questions and answers (ADR-0099).
 * Null while parked (the approval tray owns that) or when the preview is unreadable.
 */
function questionSummary(item: ToolCallView[]): AskUserSummary | null {
  const only = item.length === 1 ? item[0]! : null;

  return only && isQuestionApproval(only.toolName) ? askUserSummary(only) : null;
}

/**
 * A turn's tool calls and narration as one collapsible trail.
 * Expanded while the turn runs; collapsed to a summary when it lands.
 * `buildTrail` alone decides if there is anything to draw. Do not gate on `tools.length`:
 * a step whose cards all bounced still has prose.
 */
export function ToolCallGroup({
  tools,
  active,
  narration,
  subAgents = NO_SUB_AGENTS,
}: {
  tools: ToolCallView[];
  active: boolean;
  /** Required so a caller cannot silently drop prose. Pass `[]` when a persisted turn has none. */
  narration: readonly SyncedChatNarration[];
  /** Live sub-agent trails, each shown in the `spawn_sub_agent` card it names. Empty on reload. */
  subAgents?: readonly SubAgentTrail[] | undefined;
}) {
  const contentId = useId();
  // auto-animate owns enter/move here (cards skip `animate-chat-in` via `inTrail`). It honors reduced motion.
  const [trailRef] = useAutoAnimate<HTMLDivElement>();
  // Open while active, collapse when done. Set during render to avoid a flash.
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
   * Hide an `await_sub_agent` card when that child's trail is already on screen.
   * It still counts in `tools` for the headline.
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

    if (loneTrail) return <SubAgentCard tool={only.tools[0]!} trail={loneTrail} />;
    const loneQuestion = questionSummary(only.tools);

    return loneQuestion ? (
      <QuestionAnswersCard summary={loneQuestion} />
    ) : (
      <ToolCallCard tools={only.tools} />
    );
  }

  // Inline, no capped height: the feed's stick-to-bottom keeps the current step in view.
  const rail = (
    <div
      ref={trailRef}
      className="mt-1.5 ml-3 flex flex-col gap-1.5 border-l-2 border-app-fg-a1 pl-3"
    >
      {trail.map((item) => {
        if (item.kind !== "tool") return <NarrationRow key={item.key} text={item.text} />;

        if (isRedundantAwait(item.tools)) return null;
        const subAgent = trailFor(item.tools);

        if (subAgent) return <SubAgentCard key={item.key} tool={item.tools[0]!} trail={subAgent} />;
        const question = questionSummary(item.tools);

        return question ? (
          <QuestionAnswersCard key={item.key} summary={question} inTrail />
        ) : (
          <ToolCallCard key={item.key} tools={item.tools} inTrail />
        );
      })}
    </div>
  );

  // Prose with no cards: nothing to summarize. Must return before the `tools[…]!` reads below.
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

/** A narration line between tool cards, marked with a dot. */
function NarrationRow({ text }: { text: string }) {
  return (
    // No `animate-chat-in`: the trail's auto-animate owns this row.
    <div className="flex items-start gap-2">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-app-fg-2" />
      </span>
      <ChatProse className="min-w-0 flex-1 py-0.5">{text}</ChatProse>
    </div>
  );
}
