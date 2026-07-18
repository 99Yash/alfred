import type { SyncedChatMessage } from "@alfred/sync";
import { ArrowDown, ArrowUp, Repeat, Zap } from "lucide-react";
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
      <span className="text-app-fg-3">{value}</span>
      {suffix ? <span className="text-app-fg-1">{suffix}</span> : null}
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="h-3 w-px bg-app-bg-a3" />;
}

/**
 * A hairline meter for the cache-hit share — the single biggest lever on turn
 * cost, so it earns a glance-able bar rather than a bare number. Amber fill on a
 * faint track, matching the `Zap` accent.
 */
function CacheMeter({ pct }: { pct: number }) {
  return (
    <span aria-hidden className="h-1 w-6 overflow-hidden rounded-full bg-app-bg-a3">
      <span className="block h-full rounded-full bg-app-amber-4" style={{ width: `${pct}%` }} />
    </span>
  );
}

/**
 * Dev-only per-turn token + cost readout under an assistant reply. Gated by the
 * caller on `import.meta.env.DEV` (stripped from prod bundles) — it exposes the
 * raw economics of the turn (boss run only; sub-agents bill separately) so we
 * can eyeball cost while iterating. Numbers come from the synced `usage` rollup
 * (aggregated server-side from `api_call_log`); absent on older messages.
 *
 * Craft notes: the strip reads left-to-right as flow (io → cache → cost → calls
 * → models) inside one hairline "receipt" pill. Numbers are `tabular-nums` so
 * they don't jitter as they stream in. Cost is the anchor — brand ink, a touch
 * heavier — because it's the number we're actually watching. The cache share
 * gets a tiny amber meter since it's the biggest lever on that cost. Each served
 * model wears its provider mark; a non-Anthropic chip glows amber because the
 * boss runs on `claude-*`, so a `gemini-*`/`gpt-*` model means the Anthropic
 * primary errored (spend cap, 429) and `withFallback` degraded the turn.
 */
export function UsageLine({ usage }: { usage: NonNullable<SyncedChatMessage["usage"]> }) {
  const cost = formatCost(usage.costUsd);
  const cachePct =
    usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;

  return (
    <div
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5",
        "rounded-lg border border-app-bg-a2 bg-app-bg-a1 px-2.5 py-1.5",
        "font-mono text-[11px] leading-none text-app-fg-2 tabular-nums",
      )}
    >
      <Stat icon={ArrowUp} value={formatTokens(usage.inputTokens)} title="Input tokens" />
      <Stat icon={ArrowDown} value={formatTokens(usage.outputTokens)} title="Output tokens" />
      {usage.cachedInputTokens > 0 ? (
        <span
          title={`Cached input — ${cachePct}% of input served from cache (the biggest lever on turn cost)`}
          className="inline-flex items-center gap-1"
        >
          <Zap className="size-3 shrink-0 text-app-amber-4" />
          <span className="text-app-fg-3">{formatTokens(usage.cachedInputTokens)}</span>
          <CacheMeter pct={cachePct} />
          <span className="text-app-fg-1">{cachePct}%</span>
        </span>
      ) : null}

      <Divider />

      <span
        title="Turn cost (boss run)"
        className="inline-flex items-center gap-1.5 font-medium text-app-fg-4"
      >
        <span className="text-app-fg-2">$</span>
        {cost.replace(/^\$/, "")}
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
            className="inline-flex items-center gap-1.5 rounded-md bg-app-bg-a2 px-1.5 py-1 text-app-fg-4 transition-colors hover:bg-app-bg-a3"
          >
            {fell ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-app-amber-4"
                title="Fallback from Anthropic primary"
              />
            ) : null}
            {Icon ? (
              <Icon className="size-3.5 shrink-0" style={{ color: provider?.tint }} />
            ) : null}
            <span className="font-medium">{modelLabel(m.model)}</span>
            {m.calls > 1 ? <span className="text-app-fg-2">×{m.calls}</span> : null}
          </span>
        );
      })}
    </div>
  );
}
