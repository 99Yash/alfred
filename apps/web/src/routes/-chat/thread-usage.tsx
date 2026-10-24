import type { SyncedChatMessage } from "@alfred/sync";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useMemo, useState } from "react";
import { modelLabel, providerOf } from "~/components/provider-marks";
import { useAppTheme } from "~/components/ui/v2";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { cn } from "~/lib/utils";
import { CostFlow } from "./cost-flow";
import { Tip } from "./tip";

interface TurnCost {
  messageId: string;
  costUsd: number;
  failed: boolean;
}

interface ModelTotal {
  model: string;
  calls: number;
  fallbackCalls: number;
}

/**
 * Thread usage totals for the header's usage button. Excludes the in-flight stream; consumers must say so.
 * `turnCosts` keeps feed order so the bars read left to right like the thread.
 */
function useThreadUsageSummary(messages: readonly SyncedChatMessage[]) {
  return useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    // Null until a turn has the field, so old threads show "unknown", not zero.
    let cacheWriteInputTokens: number | null = null;
    let costUsd = 0;
    let calls = 0;
    const turnCosts: TurnCost[] = [];
    const models = new Map<string, ModelTotal>();

    for (const message of messages) {
      const usage = message.usage;

      if (!usage) continue;
      turnCosts.push({
        messageId: message.id,
        costUsd: usage.costUsd,
        failed: message.status === "failed",
      });
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cachedInputTokens += usage.cachedInputTokens;

      if (usage.cacheWriteInputTokens !== null) {
        cacheWriteInputTokens = (cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
      }

      costUsd += usage.costUsd;
      calls += usage.calls;

      for (const m of usage.models) {
        const total = models.get(m.model) ?? { model: m.model, calls: 0, fallbackCalls: 0 };
        total.calls += m.calls;
        total.fallbackCalls += m.fallback?.calls ?? 0;
        models.set(m.model, total);
      }
    }

    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      costUsd,
      calls,
      turns: turnCosts.length,
      turnCosts,
      models: [...models.values()].sort((a, b) => b.calls - a.calls),
    };
  }, [messages]);
}

type ThreadUsageSummary = ReturnType<typeof useThreadUsageSummary>;

/**
 * The panel fits about 85 one-pixel bars with their gaps. Past this count, adjacent turns share a bar,
 * so a long thread stays inside the popover.
 */
const MAX_COST_BARS = 64;

interface CostBar {
  key: string;
  first: number;
  last: number;
  costUsd: number;
  failed: boolean;
}

/** One bar per turn up to {@link MAX_COST_BARS}; past it, equal runs of adjacent turns with their costs summed. */
function costBars(turns: readonly TurnCost[]): CostBar[] {
  const size = Math.ceil(turns.length / MAX_COST_BARS);
  const bars: CostBar[] = [];

  for (let start = 0; start < turns.length; start += size) {
    const run = turns.slice(start, start + size);

    bars.push({
      key: run[0]?.messageId ?? `${start}`,
      first: start + 1,
      last: start + run.length,
      costUsd: run.reduce((sum, t) => sum + t.costUsd, 0),
      failed: run.some((t) => t.failed),
    });
  }

  return bars;
}

/** One bar per metered turn (or run of turns), height by cost. Failed turns are red because they still billed. */
function TurnCostBars({ turns }: { turns: readonly TurnCost[] }) {
  const bars = costBars(turns);
  const max = Math.max(...bars.map((b) => b.costUsd));

  return (
    <div className="flex h-10 items-end gap-0.5" aria-hidden>
      {bars.map((turn) => (
        <Tip
          key={turn.key}
          label={`${turn.first === turn.last ? `Turn ${turn.first}` : `Turns ${turn.first} to ${turn.last}`} · ${formatCost(turn.costUsd)}`}
          description={
            turn.failed
              ? turn.first === turn.last
                ? "This turn failed. Its calls still billed."
                : "A turn in this run failed. Its calls still billed."
              : undefined
          }
          delayDuration={0}
        >
          {/* The full-height hit box makes a tiny bar still easy to hover. */}
          <span className="group/bar flex h-full max-w-6 min-w-px flex-1 items-end">
            <span
              className={cn(
                "min-h-px w-full transition-colors",
                turn.failed
                  ? "bg-app-red-3 group-hover/bar:bg-app-red-4"
                  : "bg-app-fg-a3 group-hover/bar:bg-app-fg-3",
              )}
              style={{ height: `${max > 0 ? (turn.costUsd / max) * 100 : 100}%` }}
            />
          </span>
        </Tip>
      ))}
    </div>
  );
}

/** A share that rounds to zero still exists, so it reads "<1%". */
function sharePct(part: number, total: number): string {
  const pct = Math.round((part / total) * 100);

  return pct === 0 ? "<1%" : `${pct}%`;
}

/** Input split into cache hits, cache writes, and fresh tokens. Old threads with no write figure show hits only. */
function InputSplit({ summary }: { summary: ThreadUsageSummary }) {
  const { inputTokens, cachedInputTokens, cacheWriteInputTokens } = summary;

  if (inputTokens === 0) return null;

  const written = cacheWriteInputTokens ?? 0;
  const fresh = Math.max(0, inputTokens - cachedInputTokens - written);

  const parts = [
    { key: "cached", label: "Cached", tokens: cachedInputTokens, fill: "bg-app-amber-4" },
    ...(cacheWriteInputTokens === null
      ? []
      : [{ key: "cold", label: "Cold", tokens: written, fill: "bg-app-sky-4" }]),
    {
      key: "fresh",
      label: cacheWriteInputTokens === null ? "Other" : "Fresh",
      tokens: fresh,
      fill: "bg-app-fg-2",
    },
  ].filter((part) => part.tokens > 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-app-bg-a3">
        {parts.map((part) => (
          <span
            key={part.key}
            className={cn("h-full min-w-px", part.fill)}
            style={{ width: `${(part.tokens / inputTokens) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-app-fg-2">
        {parts.map((part) => (
          <span key={part.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("size-1.5 rounded-full", part.fill)} />
            {part.label}
            <span className="text-app-fg-3">{formatTokens(part.tokens)}</span>
            <span>{sharePct(part.tokens, inputTokens)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-app-fg-2">{label}</span>
      <span className="text-app-fg-4">{children}</span>
    </div>
  );
}

function UsagePanel({ summary }: { summary: ThreadUsageSummary }) {
  const turnNoun = summary.turns === 1 ? "turn" : "turns";

  return (
    <div className="flex flex-col gap-4 text-[12px] leading-none tabular-nums">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-app-fg-2">Thread cost</span>
          <span className="text-xl font-semibold tracking-tight text-app-fg-4">
            <span className="text-app-fg-2">$</span>
            <CostFlow value={summary.costUsd} />
          </span>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-app-fg-2">
          <span>
            {summary.turns} {turnNoun}
          </span>
          {/* With one turn the average only repeats the total. */}
          {summary.turns > 1 ? (
            <span>{formatCost(summary.costUsd / summary.turns)} avg</span>
          ) : null}
        </div>
      </div>

      {summary.turns > 1 ? <TurnCostBars turns={summary.turnCosts} /> : null}

      <div className="flex flex-col gap-2.5">
        <Row label="Input">{formatTokens(summary.inputTokens)}</Row>
        <InputSplit summary={summary} />
      </div>

      <div className="flex flex-col gap-2.5 border-t border-app-fg-a1 pt-3">
        <Row label="Output">{formatTokens(summary.outputTokens)}</Row>
        <Row label="LLM calls">{summary.calls.toLocaleString()}</Row>
      </div>

      {summary.models.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-app-fg-a1 pt-3">
          {summary.models.map((m) => {
            const provider = providerOf(m.model);
            const Icon = provider?.Icon;

            return (
              <div key={m.model} className="flex items-center gap-2">
                {Icon ? (
                  <Icon className="size-3.5 shrink-0" style={{ color: provider.tint }} />
                ) : null}
                {/* A long model id truncates, so the tip carries the full id. */}
                <Tip label={m.model}>
                  <span className="min-w-0 truncate text-app-fg-4">{modelLabel(m.model)}</span>
                </Tip>
                {m.fallbackCalls > 0 ? (
                  <span className="shrink-0 text-app-amber-4">{m.fallbackCalls} fallback</span>
                ) : null}
                <span className="ml-auto shrink-0 text-app-fg-2">×{m.calls}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <p className="leading-snug text-app-fg-2">
        Saved turns only. The reply in progress is not counted yet.
      </p>
    </div>
  );
}

/**
 * The thread's running cost in the chat header. A click opens the breakdown:
 * cost per turn, the input cache split, output, calls, and models.
 * Nothing before a turn has usage.
 */
export function ThreadUsageButton({ messages }: { messages: readonly SyncedChatMessage[] }) {
  const summary = useThreadUsageSummary(messages);
  const { resolved } = useAppTheme();
  const [open, setOpen] = useState(false);

  if (summary.turns === 0) return null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tip label="Thread usage">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={`Thread usage: ${formatCost(summary.costUsd)}`}
            className={cn(
              "app-press inline-flex h-8 items-center rounded-control px-2 text-[12px] font-medium tabular-nums",
              "text-app-fg-3 transition-colors outline-none hover:bg-app-bg-a2 hover:text-app-fg-4",
              "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
              "data-[state=open]:bg-app-bg-a2 data-[state=open]:text-app-fg-4",
            )}
          >
            <span className="text-app-fg-2">$</span>
            <CostFlow value={summary.costUsd} />
          </button>
        </PopoverPrimitive.Trigger>
      </Tip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          data-app-theme={resolved}
          className={cn(
            "app app-frost-overlay z-50 w-72 max-w-[calc(100vw-2rem)] rounded-surface p-4",
            "app-fade-in outline-none",
          )}
        >
          <UsagePanel summary={summary} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
