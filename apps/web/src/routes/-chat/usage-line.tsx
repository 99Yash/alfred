import type { ChatMessageAgentUsage } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import { ArrowDown, ArrowUp, Repeat, Zap } from "lucide-react";
import { PROVIDERS, modelLabel, providerOf, type SvgIcon } from "~/components/provider-marks";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

/**
 * One labeled stat cell: faint icon, tabular value, optional dim suffix. The
 * strip abbreviates every number (`12.3k`), so the hover tip carries the label
 * plus the exact figure — the reason to hover at all.
 */
function Stat({
  icon: Icon,
  iconClassName,
  value,
  suffix,
  label,
  description,
}: {
  icon: SvgIcon;
  iconClassName?: React.SVGProps<SVGSVGElement>["className"] | undefined;
  value: string;
  suffix?: string | undefined;
  label: string;
  description?: string | undefined;
}) {
  return (
    <Tip label={label} description={description}>
      <span className="inline-flex items-center gap-1">
        <Icon className={cn("size-3 shrink-0 text-app-fg-1", iconClassName)} />
        <span className="text-app-fg-3">{value}</span>
        {suffix ? <span className="text-app-fg-1">{suffix}</span> : null}
      </span>
    </Tip>
  );
}

function Divider() {
  return <span aria-hidden className="h-3 w-px bg-app-bg-a3" />;
}

/** Circumference of the ring below, hoisted so it isn't recomputed per render. */
const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A dial for the cache-hit share — the single biggest lever on turn cost, so it
 * earns a glance-able shape rather than a bare number. Amber arc on a faint
 * track, matching the `Zap` accent, sized to the row's cap height. The arc
 * starts at twelve o'clock (`-rotate-90`) and fills clockwise.
 */
function CacheRing({ pct }: { pct: number }) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3 shrink-0 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-app-bg-a3"
      />
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
        className="stroke-app-amber-4"
      />
    </svg>
  );
}

/**
 * Segment fills for the cost split, in order. The boss always takes the first
 * one (brand ink, matching the cost anchor it sits beside); each worker takes
 * the next tint in the list, cycling when a turn spawns more workers than there
 * are tints. Full class strings, so Tailwind can see them.
 */
const BOSS_FILL = "bg-app-fg-4";
const WORKER_FILLS = [
  "bg-app-purple-4",
  "bg-app-sky-4",
  "bg-app-green-4",
  "bg-app-pink-4",
  "bg-app-orange-4",
] as const;

interface CostSlice {
  /** List key. Prefixed for workers so a sub-agent named `boss` can't collide. */
  key: string;
  label: string;
  fill: string;
  costUsd: number;
  calls: number;
  pct: number;
}

/**
 * Split one turn's spend into drawable slices: the boss first, then its workers
 * by size. The boss leads regardless of what it spent, so the bar always reads
 * from the same anchor and a worker's slice keeps its meaning across turns.
 */
function costSlices(agents: readonly ChatMessageAgentUsage[], total: number): CostSlice[] {
  const ordered = [...agents].sort((a, b) => {
    if ((a.subId === null) !== (b.subId === null)) return a.subId === null ? -1 : 1;
    return b.costUsd - a.costUsd;
  });
  let worker = 0;
  return ordered.map((agent) => {
    const subId = agent.subId;
    // `worker++` walks the tint list only for workers, so the boss never
    // consumes a tint and the first worker always wears the first tint.
    const fill =
      subId === null ? BOSS_FILL : (WORKER_FILLS[worker++ % WORKER_FILLS.length] ?? BOSS_FILL);
    return {
      key: subId === null ? "boss" : `sub:${subId}`,
      label: subId ?? "boss",
      fill,
      costUsd: agent.costUsd,
      calls: agent.calls,
      // A zero total means every slice is zero; flat-splitting it keeps the bar
      // drawn instead of collapsing it to an empty track.
      pct: total > 0 ? (agent.costUsd / total) * 100 : 100 / ordered.length,
    };
  });
}

/**
 * Where the turn's money went, as a stacked bar beside the total. The one thing
 * the cost number can't say on its own: a delegating turn spends most of its
 * dollars inside its sub-agents, so a total that moves without the boss doing
 * more work is only legible once the split is visible.
 *
 * Rendered only when a turn actually delegated — a solo boss turn would draw a
 * full-width bar that repeats the total, so the strip stays quiet instead. The
 * bar carries no numbers itself; the hover tip names every agent with its exact
 * dollars, share, and call count.
 */
function CostSplit({ agents, total }: { agents: readonly ChatMessageAgentUsage[]; total: number }) {
  const slices = costSlices(agents, total);
  const workers = slices.filter((s) => s.key !== "boss").length;
  return (
    <Tip
      label="Cost by agent"
      description={
        <>
          {slices.map((slice) => (
            <span key={slice.key} className="mt-0.5 flex items-center gap-1.5">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", slice.fill)} />
              <span className="min-w-0 truncate">{slice.label}</span>
              <span className="shrink-0 text-app-bg-1/45 tabular-nums">×{slice.calls}</span>
              <span className="ml-auto shrink-0 tabular-nums">
                {formatCost(slice.costUsd)} · {Math.round(slice.pct)}%
              </span>
            </span>
          ))}
        </>
      }
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="flex h-1.5 w-10 gap-px overflow-hidden rounded-full bg-app-bg-a3">
          {slices.map((slice) => (
            // `min-w-px` keeps a near-free agent visible without inflating its
            // share — the width itself stays the honest proportion.
            <span
              key={slice.key}
              className={cn("h-full min-w-px", slice.fill)}
              style={{ width: `${slice.pct}%` }}
            />
          ))}
        </span>
        <span className="text-app-fg-1">{workers === 1 ? "1 worker" : `${workers} workers`}</span>
      </span>
    </Tip>
  );
}

/**
 * Dev-only per-turn token + cost readout under an assistant reply. Gated by the
 * caller on `import.meta.env.DEV` (stripped from prod bundles) — it exposes the
 * raw economics of the whole turn (the boss run plus every sub-agent it
 * spawned) so we can eyeball cost while iterating. Numbers come from the synced
 * `usage` rollup (aggregated server-side from `api_call_log`); absent on older
 * messages.
 *
 * Craft notes: the strip reads left-to-right as flow (io → cache → cost → split
 * → calls → models) inside one hairline "receipt" pill. Numbers are
 * `tabular-nums` so they don't jitter as they stream in. Cost is the anchor —
 * brand ink, a touch heavier — because it's the number we're actually watching,
 * and on a delegating turn the stacked bar right after it says how much of that
 * number the boss itself spent. The cache share gets a tiny amber ring since
 * it's the biggest lever on that cost. Each served model wears its provider
 * mark; a non-Anthropic chip glows amber because both boss and sub-agent run on
 * `claude-*`, so a `gemini-*`/`gpt-*` model means the Anthropic primary errored
 * (spend cap, 429) and `withFallback` degraded the turn.
 *
 * Every cell carries a `Tip` hover card rather than a native `title`, so the
 * abbreviated figure keeps its exact count and its explanation one hover away.
 * `Tip` needs an ancestor `Tooltip.Provider`; `chat-shell.tsx` wraps the whole
 * chat surface in one, so this component must stay inside that tree.
 */
export function UsageLine({ usage }: { usage: NonNullable<SyncedChatMessage["usage"]> }) {
  const cost = formatCost(usage.costUsd);
  const cachePct =
    usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;

  return (
    <div
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5",
        "rounded-lg px-2.5 py-1.5",
        "text-[11px] leading-none text-app-fg-2 tabular-nums",
      )}
    >
      <Stat
        icon={ArrowUp}
        value={formatTokens(usage.inputTokens)}
        label="Input tokens"
        description={`${usage.inputTokens.toLocaleString()} tokens sent to the model this turn. Prompt, transcript, and tool results.`}
      />
      <Stat
        icon={ArrowDown}
        value={formatTokens(usage.outputTokens)}
        label="Output tokens"
        description={`${usage.outputTokens.toLocaleString()} tokens the model wrote. Prose, reasoning, and tool arguments.`}
      />
      {usage.cachedInputTokens > 0 ? (
        <Tip
          label="Cached input"
          description={`${usage.cachedInputTokens.toLocaleString()} of ${usage.inputTokens.toLocaleString()} input tokens (${cachePct}%) were served from the prompt cache. Cache hits are the biggest lever on turn cost.`}
        >
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3 shrink-0 text-app-amber-4" />
            <span className="text-app-fg-3">{formatTokens(usage.cachedInputTokens)}</span>
            <CacheRing pct={cachePct} />
            <span className="text-app-fg-1">{cachePct}%</span>
          </span>
        </Tip>
      ) : null}

      <Divider />

      <Tip
        label={`${cost} this turn`}
        description="The whole turn at the snapshot prices in api_call_log: the boss run plus every sub-agent it spawned."
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-app-fg-4">
          <span className="text-app-fg-2">$</span>
          {cost.replace(/^\$/, "")}
        </span>
      </Tip>
      {/* Only a turn that delegated has a split worth drawing: with one agent
       * the bar is a full-width restatement of the total beside it. */}
      {usage.agents.length > 1 ? <CostSplit agents={usage.agents} total={usage.costUsd} /> : null}
      <Stat
        icon={Repeat}
        value={`${usage.calls}`}
        suffix={usage.calls === 1 ? "call" : "calls"}
        label={usage.calls === 1 ? "1 LLM call" : `${usage.calls} LLM calls`}
        description="One call per generation or tool round, across the boss and every sub-agent. A high count means the turn looped through many tools."
      />

      {usage.models.length > 0 ? <Divider /> : null}

      {usage.models.map((m) => {
        const provider = providerOf(m.model);
        const fell = provider !== null && provider !== PROVIDERS.anthropic;
        const Icon = provider?.Icon;
        const served =
          m.calls === 1 ? "Served 1 call this turn." : `Served ${m.calls} calls this turn.`;
        return (
          <Tip
            key={m.model}
            label={m.model}
            description={
              fell
                ? `${served} ${provider?.label} is a fallback. The Anthropic primary errored, so withFallback degraded the turn.`
                : `${served}${provider ? ` Provider: ${provider.label}.` : ""}`
            }
          >
            <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-app-fg-4 transition-colors">
              {fell ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-app-amber-4" />
              ) : null}
              {Icon ? (
                <Icon className="size-3.5 shrink-0" style={{ color: provider?.tint }} />
              ) : null}
              <span className="font-medium">{modelLabel(m.model)}</span>
              {m.calls > 1 ? <span className="text-app-fg-2">×{m.calls}</span> : null}
            </span>
          </Tip>
        );
      })}
    </div>
  );
}
