import type { SyncedChatMessage } from "@alfred/sync";
import { useMemo } from "react";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { CostFlow } from "./cost-flow";
import { Tip } from "./tip";

/**
 * Roll a thread's durable messages up into the economics totals.
 *
 * Exported because two surfaces read the same numbers — the `ThreadTotal`
 * above the composer and the thread menu's usage row — and a second copy of this arithmetic would be
 * free to disagree with the first. The in-flight stream is not in `messages`
 * yet, so every consumer must say the total excludes it.
 */
export function useThreadUsageSummary(messages: readonly SyncedChatMessage[]) {
  return useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    // Null until a turn carries the field, so a thread of pre-field rollups
    // reports "unknown" rather than a zero cold-token total it can't support.
    let cacheWriteInputTokens: number | null = null;
    let costUsd = 0;
    let calls = 0;
    let turns = 0;
    let user = 0;
    let assistant = 0;

    for (const message of messages) {
      if (message.role === "user") user += 1;
      else if (message.role === "assistant") assistant += 1;

      const usage = message.usage;

      if (!usage) continue;
      turns += 1;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cachedInputTokens += usage.cachedInputTokens;

      if (usage.cacheWriteInputTokens !== null) {
        cacheWriteInputTokens = (cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
      }

      costUsd += usage.costUsd;
      calls += usage.calls;
    }

    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      costUsd,
      calls,
      turns,
      user,
      assistant,
    };
  }, [messages]);
}

/**
 * Thread-level rollup drawn once per thread, directly above the composer — the
 * same surface family as the per-turn `UsageLine` under each reply, so the
 * running total sits beside the receipts it sums rather than in the sticky
 * `TopBar` chrome next to the title. Derived during render from the durable
 * `messages` array: no new subscription, no mirrored state. The in-flight
 * stream isn't in `messages` yet, so the tooltip says the total excludes it
 * rather than looking wrong mid-turn. Renders nothing before a turn lands
 * with usage.
 */
export function ThreadTotal({ messages }: { messages: readonly SyncedChatMessage[] }) {
  const summary = useThreadUsageSummary(messages);

  if (summary.turns === 0) return null;

  const cost = formatCost(summary.costUsd);
  const turnNoun = summary.turns === 1 ? "turn" : "turns";

  return (
    <div className="flex justify-end">
      <Tip
        label={`${cost} across ${summary.turns} ${turnNoun}`}
        description={
          summary.turns > 0
            ? `${formatTokens(summary.inputTokens)} in (${summary.inputTokens.toLocaleString()}) · ${formatTokens(summary.outputTokens)} out (${summary.outputTokens.toLocaleString()}) · ${formatTokens(summary.cachedInputTokens)} cached${summary.cacheWriteInputTokens === null ? "" : ` · ${formatTokens(summary.cacheWriteInputTokens)} cold`} · ${summary.calls} calls. ${summary.user} user + ${summary.assistant} assistant. Excludes the in-flight turn.`
            : `${summary.user} user + ${summary.assistant} assistant. No metered turns yet — totals appear once a reply lands with usage.`
        }
      >
        <p className="text-[11px] leading-none tabular-nums">
          <span className="font-medium text-app-fg-3">
            <span className="text-app-fg-2">$</span>
            <CostFlow value={summary.costUsd} />
          </span>{" "}
          <span className="text-app-fg-1">
            total · {summary.turns} {turnNoun} · {formatTokens(summary.inputTokens)} in ·{" "}
            {formatTokens(summary.outputTokens)} out
          </span>
        </p>
      </Tip>
    </div>
  );
}
