import type { SyncedChatMessage } from "@alfred/sync";
import { ArrowDown, ArrowUp, Coins, Repeat, Zap } from "lucide-react";
import { PROVIDERS, modelLabel, providerOf, type SvgIcon } from "~/components/provider-marks";
import { formatCost, formatTokens } from "~/lib/usage-format";
import { cn } from "~/lib/utils";

/** One labeled stat cell: faint icon, tabular value, optional dim suffix. */
function Stat({
  icon: Icon,
  iconClassName,
  value,
  suffix,
  title,
}: {
  icon: SvgIcon;
  iconClassName?: string;
  value: string;
  suffix?: string;
  title: string;
}) {
  return (
    <span title={title} className="inline-flex items-center gap-1">
      <Icon className={cn("size-3 shrink-0 text-app-fg-1", iconClassName)} />
      <span>{value}</span>
      {suffix ? <span className="text-app-fg-1">{suffix}</span> : null}
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-3 w-px bg-app-bg-a3" />;
}

/**
 * Dev-only per-turn token + cost readout under an assistant reply. Gated by the
 * caller on `import.meta.env.DEV` (stripped from prod bundles) — it exposes the
 * raw economics of the turn (boss run only; sub-agents bill separately) so we
 * can eyeball cost while iterating. Numbers come from the synced `usage` rollup
 * (aggregated server-side from `api_call_log`); absent on older messages.
 *
 * Craft notes: numbers are `tabular-nums` so they don't jitter as they update,
 * grouped left-to-right as flow (tokens → cost → calls → models) with hairline
 * dividers, and each served model wears its provider mark. A non-Anthropic mark
 * is tinted amber — the boss runs on `claude-*`, so a `gemini-*`/`gpt-*` chip
 * means the Anthropic primary errored (spend cap, 429) and `withFallback`
 * degraded the turn. The cache stat shows the share of input served from cache,
 * the single biggest lever on turn cost.
 */
export function UsageLine({ usage }: { usage: NonNullable<SyncedChatMessage["usage"]> }) {
  const cost = formatCost(usage.costUsd);
  const cachePct =
    usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-app-fg-2 tabular-nums">
      <Stat icon={ArrowUp} value={formatTokens(usage.inputTokens)} title="Input tokens" />
      <Stat icon={ArrowDown} value={formatTokens(usage.outputTokens)} title="Output tokens" />
      {usage.cachedInputTokens > 0 ? (
        <Stat
          icon={Zap}
          iconClassName="text-app-amber-4"
          value={formatTokens(usage.cachedInputTokens)}
          suffix={`${cachePct}%`}
          title={`Cached input tokens — ${cachePct}% of input served from cache`}
        />
      ) : null}

      <Divider />

      <span
        title="Turn cost (boss run)"
        className="inline-flex items-center gap-1 font-medium text-app-fg-3"
      >
        <Coins className="size-3 shrink-0 text-app-fg-1" />
        {cost}
      </span>
      <Stat
        icon={Repeat}
        value={`${usage.calls}`}
        suffix={usage.calls === 1 ? "call" : "calls"}
        title="LLM calls this turn"
      />

      {usage.models.length > 0 ? <Divider /> : null}

      {usage.models.map((m) => {
        const provider = providerOf(m.model);
        const fell = provider !== null && provider !== PROVIDERS.anthropic;
        const Icon = provider?.Icon;
        return (
          <span
            key={m.model}
            title={
              provider
                ? `${provider.label} — model served this turn${m.calls > 1 ? ` (${m.calls} calls)` : ""}${fell ? " · fallback from Anthropic primary" : ""}`
                : "Model served this turn"
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors",
              fell
                ? "bg-app-amber-1 text-app-fg-3 ring-1 ring-app-amber-3 ring-inset hover:bg-app-amber-2"
                : "bg-app-bg-a2 text-app-fg-3 hover:bg-app-bg-a3",
            )}
          >
            {Icon ? (
              <Icon
                className="size-3 shrink-0"
                style={{ color: fell ? "var(--app-amber-4)" : provider?.tint }}
              />
            ) : null}
            <span className="font-medium">{modelLabel(m.model)}</span>
            {m.calls > 1 ? <span className="text-app-fg-1">×{m.calls}</span> : null}
          </span>
        );
      })}
    </div>
  );
}
