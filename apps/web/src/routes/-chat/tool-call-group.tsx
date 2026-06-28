import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight, Wrench } from "lucide-react";
import { useId, useRef, useState } from "react";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { lowerFirst } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { animatedToolIcon, type AnimatedIcon } from "./animated-tool-icons";
import { ToolCallCard } from "./tool-call-card";
import { presentTool, toolCategory, type ToolCallView } from "./tool-call-presentation";

const ITEM = "tools";

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
        head.status === tool.status
      ) {
        prev.tools.push(tool);
      } else {
        items.push({ kind: "tool", key: tool.toolCallId, tools: [tool] });
      }
    }
  }
  return items;
}

/** Max coins stacked in the summary cluster before we stop adding more. */
const MAX_GLYPHS = 3;

/** One coin in the run summary: an integration brand tile, or a system mark. */
type RunGlyph =
  | { kind: "brand"; key: string; brand: IntegrationBrand }
  | { kind: "icon"; key: string; Icon: AnimatedIcon };

/**
 * The distinct glyphs a finished run touched, in first-seen order: an
 * integration's brand coin where the tool has one, otherwise the system tool's
 * own animated mark (web_search → chrome, …). Deduped so repeated calls collapse
 * to a single coin and a Gmail-read-then-web-search run reads as gmail + chrome.
 */
function runGlyphs(tools: ToolCallView[]): RunGlyph[] {
  const glyphs: RunGlyph[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const { brand } = presentTool(tool);
    if (brand) {
      if (seen.has(`brand:${brand}`)) continue;
      seen.add(`brand:${brand}`);
      glyphs.push({ kind: "brand", key: brand, brand });
      continue;
    }
    const animatedIcon = animatedToolIcon(tool.toolName);
    if (animatedIcon) {
      if (seen.has(`icon:${animatedIcon.key}`)) continue;
      seen.add(`icon:${animatedIcon.key}`);
      glyphs.push({ kind: "icon", key: animatedIcon.key, Icon: animatedIcon.Icon });
    }
  }
  return glyphs;
}

/**
 * Narrative headline for a finished run — what Alfred *did*, as a sentence
 * rather than a tally. Reads vs. writes are split by `toolCategory`:
 *  - one kind of read → that read's done label   ("Checked your calendar")
 *  - several reads     → "Searched multiple sources"
 *  - one write          → that write's done label  ("Sent a Gmail draft")
 *  - several writes      → "Finished N actions"
 *  - both                → "<reads> and <writes, lowercased>"
 * The integration glyphs alongside the headline already say *which* services
 * were touched, so the text is free to describe the shape of the work. Plumbing
 * (connecting an integration, spawning a sub-agent) is excluded from the tally.
 */
function runSummary(tools: ToolCallView[]): string {
  const sources = tools.filter((t) => toolCategory(t.toolName) === "source");
  const actions = tools.filter((t) => toolCategory(t.toolName) === "action");

  const distinctSources = new Set(sources.map((t) => t.toolName));
  const sourceClause =
    sources.length === 0
      ? null
      : distinctSources.size === 1
        ? presentTool(sources[0]!).done
        : "Searched multiple sources";

  const actionClause =
    actions.length === 0
      ? null
      : actions.length === 1
        ? presentTool(actions[0]!).done
        : `Finished ${actions.length} actions`;

  if (sourceClause && actionClause) {
    return `${sourceClause} and ${lowerFirst(actionClause)}`;
  }
  return actionClause ?? sourceClause ?? "Worked on it";
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
}: {
  tools: ToolCallView[];
  active: boolean;
  narration?: readonly TrailNarration[];
}) {
  const contentId = useId();
  // Open while the turn runs so narration + tools stream into view; collapse to
  // the summary once it finishes. Re-asserting on the active transition during
  // render (rather than in an effect) avoids a flash and lets the user still
  // toggle freely between transitions.
  const [value, setValue] = useState(active ? ITEM : "");
  const prevActive = useRef(active);
  if (prevActive.current !== active) {
    prevActive.current = active;
    setValue(active ? ITEM : "");
  }

  if (tools.length === 0) return null;
  if (tools.length === 1 && narration.length === 0) return <ToolCallCard tools={[tools[0]!]} />;

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
              "transition-colors duration-150 hover:bg-app-bg-a2 outline-none focus-visible:ring-2 focus-visible:ring-app-fg-2",
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
                className="text-app-fg-2 transition-transform duration-200 group-data-[state=open]/tools:rotate-90"
              />
            </span>
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content
          id={contentId}
          className="overflow-hidden data-[state=closed]:animate-chat-accordion-up data-[state=open]:animate-chat-accordion-down"
        >
          {/* The trail flows inline in the conversation feed — no capped height
           * or nested scrollbar. The feed's own stick-to-bottom keeps the
           * model's current step in view as the trail grows, so a long agentic
           * run reads as one continuous timeline rather than a cramped box. */}
          <div className="ml-3 mt-1.5 flex flex-col gap-1.5 border-l-2 border-app-fg-a1 pl-3">
            {trail.map((item) =>
              item.kind === "tool" ? (
                <ToolCallCard key={item.key} tools={item.tools} />
              ) : (
                <NarrationRow key={item.key} text={item.text} />
              ),
            )}
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
    <div className="animate-chat-in flex items-start gap-2 text-[13px] leading-relaxed text-app-fg-3">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-app-fg-2" />
      </span>
      <span className="min-w-0 py-0.5">{text}</span>
    </div>
  );
}

/**
 * Overlapping coins for the glyphs a run touched (max 3) — integration app-icon
 * tiles and/or system marks, in the order the run first hit them. A run with no
 * mappable glyph (only unmapped system plumbing) falls back to a lone wrench.
 */
function RunGlyphCluster({ glyphs }: { glyphs: RunGlyph[] }) {
  if (glyphs.length === 0) {
    return (
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-[var(--app-shadow-elevated)]"
      >
        <Wrench size={13} />
      </span>
    );
  }
  // ring matches the page background so overlapping coins read as a clean stack
  // rather than a smudge.
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {glyphs.slice(0, MAX_GLYPHS).map((glyph, i) =>
        glyph.kind === "brand" ? (
          <IntegrationIcon
            key={glyph.key}
            brand={glyph.brand}
            size="xs"
            className={cn("ring-2 ring-app-background", i > 0 && "-ml-2")}
          />
        ) : (
          // System tool with no brand — its animated mark on a neutral coin,
          // sized to match the brand tiles. Static here; plays on row hover.
          <span
            key={glyph.key}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-[var(--app-shadow-elevated)] ring-2 ring-app-background",
              i > 0 && "-ml-2",
            )}
          >
            <glyph.Icon size={13} className="tool-animated-icon tool-animated-icon--hoverable" />
          </span>
        ),
      )}
    </span>
  );
}
