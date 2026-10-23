import * as Accordion from "@radix-ui/react-accordion";
import { AWAIT_SUB_AGENT_TOOL, isQuestionApproval, SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";
import type { SyncedChatNarration } from "@alfred/sync";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { askUserSummary, type AskUserSummary } from "~/components/approvals/ask-user";
import { QuestionAnswersCard } from "~/components/approvals/question-answers-card";
import type { SubAgentTrail } from "~/lib/chat/chat-stream-state";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { ChatProse } from "./chat-prose";
import { CollapseItem, CollapseList } from "./collapse-list";
import { RunGlyphCluster } from "./run-glyph-cluster";
import { runGlyphs, runSummary } from "./run-summary";
import { SubAgentCard } from "./sub-agent-card";
import { ToolCallCard } from "./tool-call-card";
import { presentTool, type ToolCallView, visibleTools } from "./tool-call-presentation";
import { buildTrail, type TrailItem } from "./trail";

const ITEM = "tools";

const NO_SUB_AGENTS: readonly SubAgentTrail[] = [];

/**
 * A settled `system.ask_user` call shows its questions and answers (ADR-0099).
 * Null while parked (the approval tray owns that) or when the preview is unreadable.
 */
function questionSummary(item: ToolCallView[]): AskUserSummary | null {
  const only = item.length === 1 ? item[0] : undefined;

  return only && isQuestionApproval(only.toolName) ? askUserSummary(only) : null;
}

/**
 * A turn's tool calls and narration as one collapsible trail.
 * Expanded while the turn runs; collapsed to a summary when it lands.
 * It draws `visibleTools(tools)` only: the trail, header, glyphs, and failed dot never see plumbing.
 * While the turn runs, hidden plumbing is still live work: the header stays so it can say
 * "Working on it" instead of leaving no live label. Gated on `active`, so the persisted
 * bubble keeps the settled layout.
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
  // Open while active, collapse when done. Set during render to avoid a flash.
  const [value, setValue] = useState(active ? ITEM : "");
  const [prevActive, setPrevActive] = useState(active);

  if (prevActive !== active) {
    setPrevActive(active);
    setValue(active ? ITEM : "");
  }

  /** A lone `spawn_sub_agent` call and the child trail it names. */
  const subAgentFor = (
    item: ToolCallView[],
  ): { tool: ToolCallView; childTrail: SubAgentTrail } | undefined => {
    const [tool] = item;

    if (item.length !== 1 || tool?.toolName !== SPAWN_SUB_AGENT_TOOL) return undefined;
    const childTrail = subAgents.find((s) => s.parentToolCallId === tool.toolCallId);

    return childTrail ? { tool, childTrail } : undefined;
  };

  /**
   * Hide an `await_sub_agent` card when that child's trail is already on screen.
   * It still counts in `shown` for the headline.
   */
  const isRedundantAwait = (item: ToolCallView[]): boolean => {
    const [tool] = item;

    if (item.length !== 1 || tool?.toolName !== AWAIT_SUB_AGENT_TOOL) return false;
    const childRunId = asString(parseJsonRecord(tool.argsPreview)?.childRunId);

    return childRunId !== undefined && subAgents.some((s) => s.childRunId === childRunId);
  };

  const shown = visibleTools(tools);
  const trail = buildTrail(shown, narration);

  // Hidden plumbing draws no row but is still live work while the turn runs.
  // Keep the header (never the lone-card branch) so the turn always names it.
  // `active` gates it: the persisted bubble renders the settled layout.
  const hasHiddenLiveWork = active && tools.length > shown.length;

  if (trail.length === 0 && !hasHiddenLiveWork) return null;

  const only = trail.length === 1 ? trail[0] : undefined;

  if (!hasHiddenLiveWork && only?.kind === "tool" && only.tools.length === 1) {
    const loneSubAgent = subAgentFor(only.tools);

    if (loneSubAgent) {
      return <SubAgentCard tool={loneSubAgent.tool} trail={loneSubAgent.childTrail} />;
    }

    const loneQuestion = questionSummary(only.tools);

    // Outside the trail, this group owns the lone card's entrance.
    return (
      <div className="animate-chat-in w-full">
        {loneQuestion ? (
          <QuestionAnswersCard summary={loneQuestion} />
        ) : (
          <ToolCallCard tools={only.tools} live={active} />
        )}
      </div>
    );
  }

  const trailRow = (item: TrailItem): ReactNode => {
    if (item.kind !== "tool") return <NarrationRow text={item.text} />;
    const subAgent = subAgentFor(item.tools);

    if (subAgent) return <SubAgentCard tool={subAgent.tool} trail={subAgent.childTrail} />;
    const question = questionSummary(item.tools);

    return question ? (
      <QuestionAnswersCard summary={question} />
    ) : (
      <ToolCallCard tools={item.tools} live={active} />
    );
  };

  // Inline, no capped height: the anchored question holds still while the reply grows
  // into the reserve below it, and a click on the pill jumps to the live end once it
  // outgrows the viewport.
  // Each trail row owns its enter and exit, so the cards inside run no `animate-chat-in`.
  const rail = (
    <CollapseList className="mt-1.5 ml-3 flex flex-col gap-1.5 border-l-2 border-app-fg-a1 pl-3">
      {trail.map((item) => {
        if (item.kind === "tool" && isRedundantAwait(item.tools)) return null;

        return <CollapseItem key={item.key}>{trailRow(item)}</CollapseItem>;
      })}
    </CollapseList>
  );

  // Prose with no cards: nothing to summarize. A tool item in the trail means `shown` is not empty.
  // A hidden step that runs last leaves `last` settled, so the header reads "Working on it".
  // With hidden live work and no visible `last`, the header still reads "Working on it".
  const last = shown.at(-1);

  if (!hasHiddenLiveWork && (!last || !trail.some((item) => item.kind === "tool"))) {
    return <div className="animate-chat-in w-full">{rail}</div>;
  }

  const runningLabel =
    last && last.status === "started" ? presentTool(last).running : "Working on it";

  const anyFailed = shown.some((t) => t.status === "failed");
  const glyphs = runGlyphs(shown);

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
              {active ? runningLabel : runSummary(shown)}
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
    // No `animate-chat-in`: the trail row around it owns the entrance.
    <div className="flex items-start gap-2">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-app-fg-2" />
      </span>
      <ChatProse className="min-w-0 flex-1 py-0.5">{text}</ChatProse>
    </div>
  );
}
