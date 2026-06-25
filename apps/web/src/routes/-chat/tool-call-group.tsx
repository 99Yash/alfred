import * as Accordion from "@radix-ui/react-accordion";
import { ChevronRight, Wrench } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { lowerFirst } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { ToolCallCard } from "./tool-call-card";
import { presentTool, toolCategory, type ToolCallView } from "./tool-call-presentation";

const ITEM = "tools";

/** Slack (px) within which the trail counts as "at the bottom" for auto-pinning. */
const NEAR_BOTTOM_PX = 24;

/** A closed narration segment — the brief line the model wrote before a tool step. */
export interface TrailNarration {
  index: number;
  text: string;
}

const EMPTY_NARRATION: readonly TrailNarration[] = [];

type TrailItem =
  | { kind: "narration"; key: string; text: string }
  | { kind: "tool"; key: string; tool: ToolCallView };

/**
 * Weave the model's narration lines and its tool calls into one ordered trail.
 * Both carry a `segmentIndex`: segment N's narration precedes the tools the
 * model called in step N. Within a segment, the narration line comes first,
 * then its tools in arrival order — mirroring how the turn actually streamed.
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
      items.push({ kind: "tool", key: tool.toolCallId, tool });
    }
  }
  return items;
}

/** Distinct integration glyphs touched across the run, in first-seen order. */
function runBrands(tools: ToolCallView[]): IntegrationBrand[] {
  const brands: IntegrationBrand[] = [];
  const seenBrands = new Set<IntegrationBrand>();
  for (const tool of tools) {
    const { brand } = presentTool(tool);
    if (brand && !seenBrands.has(brand)) {
      seenBrands.add(brand);
      brands.push(brand);
    }
  }
  return brands;
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

  // While the turn runs, the capped trail box would otherwise pin to the top and
  // hide the newest step below the fold — keep it stuck to the bottom so the
  // step the model is currently on stays in view as the trail grows. But only
  // while the user is already at the bottom: if they scrolled up to read an
  // earlier step, don't yank them back on every new tool/narration update.
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const handleTrailScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    // A user scroll fires this; appending content does not — so this latches
    // the user's intent and survives subsequent content growth.
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };
  useEffect(() => {
    if (!active) return;
    const el = contentRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [tools, narration, active]);

  if (tools.length === 0) return null;
  if (tools.length === 1 && narration.length === 0) return <ToolCallCard tool={tools[0]!} />;

  const trail = buildTrail(tools, narration);
  const last = tools[tools.length - 1]!;
  const runningLabel = last.status === "started" ? presentTool(last).running : "Working on it";
  const anyFailed = tools.some((t) => t.status === "failed");
  const brands = runBrands(tools);

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
              <BrandCluster brands={brands} />
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
          <div
            ref={contentRef}
            onScroll={handleTrailScroll}
            className="ml-3 mt-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto overscroll-contain border-l-2 border-app-fg-a1 pl-3"
          >
            {trail.map((item) =>
              item.kind === "tool" ? (
                <ToolCallCard key={item.key} tool={item.tool} />
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

/** Overlapping integration app-icon coins for the services a run touched (max 3). */
function BrandCluster({ brands }: { brands: IntegrationBrand[] }) {
  if (brands.length === 0) {
    return (
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-app-bg-2 text-app-fg-3 shadow-[var(--app-shadow-elevated)]"
      >
        <Wrench size={13} />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {brands.slice(0, 3).map((brand, i) => (
        // ring matches the page background so overlapping tiles read as a
        // clean stack rather than a smudge.
        <IntegrationIcon
          key={brand}
          brand={brand}
          size="xs"
          className={cn("ring-2 ring-app-background", i > 0 && "-ml-2")}
        />
      ))}
    </span>
  );
}
