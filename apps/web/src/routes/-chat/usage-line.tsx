import type { ChatMessageAgentUsage, ChatMessageUsage } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import { ArrowDown, ArrowUp, Gauge, Repeat, Snowflake, TriangleAlert, Zap } from "lucide-react";
import { modelLabel, providerOf, type SvgIcon } from "~/components/provider-marks";
import { formatCost, formatTokens, outputTokensPerSecond } from "~/lib/usage-format";
import { cn } from "~/lib/utils";
import { CostFlow } from "./cost-flow";
import { Tip } from "./tip";

/** One stat cell. The strip abbreviates numbers, so the tip shows the exact figure. */
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

type ModelFallback = NonNullable<ChatMessageUsage["models"][number]["fallback"]>;

/** Why a chip glows amber: fallback call count and, if recorded, the failed primary. */
function fallbackNote(fallback: ModelFallback, calls: number): string {
  const share =
    fallback.calls === calls ? (calls === 1 ? "It" : "Every call") : `${fallback.calls} of them`;

  const primary = fallback.primary ? `the primary (${fallback.primary})` : "the primary";

  return `${share} ran here as a fallback: ${primary} errored, so withFallback degraded the turn.`;
}

/**
 * Input split: cache hit, cache write, and fresh. Without the write figure, readers take it for fresh input.
 * Omitted for old rollups with no write field, where "fresh" would be a guess.
 */
function cacheSplitNote(usage: ChatMessageUsage): string {
  const written = usage.cacheWriteInputTokens;

  if (written === null) return "Cache hits are the biggest lever on turn cost.";

  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens - written);

  return `Split: ${usage.cachedInputTokens.toLocaleString()} read from the cache, ${written.toLocaleString()} written into it, ${fresh.toLocaleString()} neither.`;
}

const RING_RADIUS = 5;

const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Cache-hit dial: an amber arc from twelve o'clock, clockwise. */
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

/** Cost-split fills: the boss first, then workers cycle the tints. Full strings so Tailwind sees them. */
const BOSS_FILL = "bg-app-fg-4";

const WORKER_FILLS = [
  "bg-app-purple-4",
  "bg-app-sky-4",
  "bg-app-green-4",
  "bg-app-pink-4",
  "bg-app-orange-4",
] as const;

interface CostSlice {
  /** Workers are prefixed so a sub-agent named `boss` cannot collide. */
  key: string;
  label: string;
  fill: string;
  costUsd: number;
  calls: number;
  pct: number;
}

/** Boss first, then workers by size, so the bar always starts from the same anchor. */
function costSlices(agents: readonly ChatMessageAgentUsage[], total: number): CostSlice[] {
  const ordered = [...agents].sort((a, b) => {
    if ((a.subId === null) !== (b.subId === null)) return a.subId === null ? -1 : 1;

    return b.costUsd - a.costUsd;
  });

  let worker = 0;

  return ordered.map((agent) => {
    const subId = agent.subId;

    // Only workers advance `worker`, so the first worker gets the first tint.
    const fill =
      subId === null ? BOSS_FILL : (WORKER_FILLS[worker++ % WORKER_FILLS.length] ?? BOSS_FILL);

    return {
      key: subId === null ? "boss" : `sub:${subId}`,
      label: subId ?? "boss",
      fill,
      costUsd: agent.costUsd,
      calls: agent.calls,
      // Zero total: split evenly so the bar still draws.
      pct: total > 0 ? (agent.costUsd / total) * 100 : 100 / ordered.length,
    };
  });
}

/**
 * Stacked bar of where the turn's money went; sub-agents can spend most of it.
 * Drawn only for delegating turns. The tip names each agent's dollars, share, and calls.
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
            // `min-w-px` keeps a near-free agent visible.
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

export type UsageTone = "ok" | "failed";

/**
 * Failure tone: red pill and red cost. Cache cells keep their colors; a fault does not change caching.
 * Full strings so Tailwind sees them.
 */
const TONE = {
  ok: { container: "", cost: "text-app-fg-4" },
  failed: { container: "bg-app-red-1", cost: "text-app-red-4" },
} satisfies Record<UsageTone, { container: string; cost: string }>;

/**
 * Per-turn token and cost strip for the boss and its sub-agents, from the synced `usage` rollup.
 * Amber chip: `usage.models[].fallback` saw a `withFallback` degrade. Effort comes from `usage.effort`.
 * `Tip` needs the `Tooltip.Provider` in `chat-shell.tsx`. A failed turn keeps its numbers ({@link TONE}).
 */
export function UsageLine({
  usage,
  tone = "ok",
}: {
  usage: NonNullable<SyncedChatMessage["usage"]>;
  tone?: UsageTone | undefined;
}) {
  const toneClass = TONE[tone];
  const cost = formatCost(usage.costUsd);
  const tokensPerSecond = outputTokensPerSecond(usage.outputTokens, usage.modelLatencyMs);

  const cachePct =
    usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;

  // Old rollups have `null`. Fold to 0 so an unknown never claims a warm or cold cache.
  const cacheWritten = usage.cacheWriteInputTokens ?? 0;

  const effort = usage.effort ?? "no effort";
  const effortLabel = effort.slice(0, 1).toUpperCase() + effort.slice(1);

  return (
    <div
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5",
        "rounded-lg px-2.5 py-1.5",
        "text-[11px] leading-none text-app-fg-2 tabular-nums",
        toneClass.container,
      )}
    >
      {/* Leads the strip so the reader knows these numbers paid for a failure. */}
      {tone === "failed" ? (
        <Tip
          label="The turn failed"
          description="These tokens were still billed. A turn pays for every model call it made before the fault, so a turn that died late can be the most expensive one in the thread."
        >
          <span className="inline-flex items-center">
            <TriangleAlert className="size-3 shrink-0 text-app-red-4" />
          </span>
        </Tip>
      ) : null}
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
      {tokensPerSecond !== null ? (
        <Stat
          icon={Gauge}
          value={tokensPerSecond.toFixed(1)}
          suffix="tok/s"
          label={`${tokensPerSecond.toFixed(1)} average output tokens per second`}
          description={`${usage.outputTokens.toLocaleString()} output tokens across ${(usage.modelLatencyMs / 1_000).toFixed(1)} seconds of model calls. Time to first token is included. Tool execution and other workflow time are excluded.`}
        />
      ) : null}
      {usage.cachedInputTokens > 0 ? (
        <Tip
          label="Cached input"
          description={`${usage.cachedInputTokens.toLocaleString()} of ${usage.inputTokens.toLocaleString()} input tokens (${cachePct}%) were served from the prompt cache. ${cacheSplitNote(usage)}`}
        >
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3 shrink-0 text-app-amber-4" />
            <span className="text-app-fg-3">{formatTokens(usage.cachedInputTokens)}</span>
            <CacheRing pct={cachePct} />
            <span className="text-app-fg-1">{cachePct}%</span>
          </span>
        </Tip>
      ) : null}
      {/* The miss half; no divider from the hit cell. */}
      {cacheWritten > 0 ? (
        <Tip
          label="Cold input"
          description={`${cacheWritten.toLocaleString()} of ${usage.inputTokens.toLocaleString()} input tokens missed the prompt cache and were written into it. A write bills ABOVE the plain input rate, so a cold turn costs more than an uncached one. ${cacheSplitNote(usage)}`}
        >
          <span className="inline-flex items-center gap-1">
            <Snowflake className="size-3 shrink-0 text-app-sky-4" />
            <span className="text-app-fg-3">{formatTokens(cacheWritten)}</span>
            <span className="text-app-fg-1">cold</span>
          </span>
        </Tip>
      ) : null}

      <Divider />

      <Tip
        label={`${cost} this turn`}
        description="The whole turn at the snapshot prices in api_call_log: the boss run plus every sub-agent it spawned."
      >
        <span className={cn("inline-flex items-center gap-1.5 font-medium", toneClass.cost)}>
          <span className="text-app-fg-2">$</span>
          <CostFlow value={usage.costUsd} />
        </span>
      </Tip>
      {/* With one agent the bar only repeats the total. */}
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
        // Old rollups may lack the field; absent means no degrade.
        const fallback = m.fallback ?? null;
        const Icon = provider?.Icon;

        const served =
          m.calls === 1 ? "Served 1 call this turn." : `Served ${m.calls} calls this turn.`;

        // One effort value for the whole turn; every chip repeats it.
        const effortNote = `Ran at ${effort} reasoning effort (the turn's ceiling; each provider maps it to its own scale).`;

        return (
          <Tip
            key={m.model}
            label={`${m.model} · ${effort}`}
            description={
              fallback
                ? `${served} ${fallbackNote(fallback, m.calls)} ${effortNote}`
                : `${served}${provider ? ` Provider: ${provider.label}.` : ""} ${effortNote}`
            }
          >
            <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-app-fg-4 transition-colors">
              {fallback ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-app-amber-4" />
              ) : null}
              {Icon ? (
                <Icon className="size-3.5 shrink-0" style={{ color: provider?.tint }} />
              ) : null}
              <span className="font-medium">{modelLabel(m.model)}</span>
              <span className="text-app-fg-2">· {effortLabel}</span>
              {m.calls > 1 ? <span className="text-app-fg-2">×{m.calls}</span> : null}
            </span>
          </Tip>
        );
      })}
    </div>
  );
}
