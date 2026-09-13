import type { SyncedChatMessage } from "@alfred/sync";
import { useMemo } from "react";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { Tip } from "./tip";

/**
 * Roll a thread's durable messages up into the economics totals.
 *
 * Exported because two surfaces read the same numbers — the `TopBar` chip and
 * the thread menu's usage row — and a second copy of this arithmetic would be
 * free to disagree with the first. The in-flight stream is not in `messages`
 * yet, so every consumer must say the total excludes it.
 */
export function useThreadUsageSummary(messages: readonly SyncedChatMessage[]) {
  return useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
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
      costUsd += usage.costUsd;
      calls += usage.calls;
    }

    return { inputTokens, outputTokens, cachedInputTokens, costUsd, calls, turns, user, assistant };
  }, [messages]);
}

/**
 * Thread-level rollup for the dev-gated economics readout. The per-turn
 * `UsageLine` under each reply stays turn-scoped; this chip lives in the
 * sticky `TopBar` chrome so the running total is visible without scrolling
 * (wayfinding) and never repeats once per reply (grouping).
 *
 * Derived during render from the durable `messages` array — no new
 * subscription, no mirrored state. The in-flight stream isn't in `messages`
 * yet, so the tooltip says the total excludes it rather than looking wrong
 * mid-turn. Gated on `import.meta.env.DEV` by the caller, mirroring
 * `message-bubble.tsx`.
 */
export function ThreadUsage({ messages }: { messages: readonly SyncedChatMessage[] }) {
  const summary = useThreadUsageSummary(messages);

  const total = messages.length;

  if (total === 0) return null;

  const cost = formatCost(summary.costUsd);
  const turnNoun = summary.turns === 1 ? "turn" : "turns";
  const messageNoun = total === 1 ? "message" : "messages";

  return (
    <Tip
      label={
        summary.turns > 0
          ? `${cost} across ${summary.turns} ${turnNoun}`
          : `${total} ${messageNoun}`
      }
      description={
        summary.turns > 0
          ? `${formatTokens(summary.inputTokens)} in (${summary.inputTokens.toLocaleString()}) · ${formatTokens(summary.outputTokens)} out (${summary.outputTokens.toLocaleString()}) · ${formatTokens(summary.cachedInputTokens)} cached · ${summary.calls} calls. ${summary.user} user + ${summary.assistant} assistant across ${total} ${messageNoun}. Excludes the in-flight turn.`
          : `${summary.user} user + ${summary.assistant} assistant. No metered turns yet — totals appear once a reply lands with usage.`
      }
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] leading-none tabular-nums">
        {summary.turns > 0 ? (
          <span className="font-medium text-app-fg-4">
            <span className="text-app-fg-2">$</span>
            {cost.replace(/^\$/, "")}
          </span>
        ) : null}
        <span className="text-app-fg-1">
          {summary.turns > 0
            ? `${summary.turns} ${turnNoun} · ${total} ${messageNoun}`
            : `${total} ${messageNoun}`}
        </span>
      </span>
    </Tip>
  );
}
