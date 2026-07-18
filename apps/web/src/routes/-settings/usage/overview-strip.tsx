import { Coins, Hash, Layers, Repeat } from "lucide-react";
import type { ComponentType } from "react";
import { AppCard } from "~/components/ui/v2";
import { formatCost, formatTokens } from "./format";
import { useUsageSummary } from "./use-usage";

interface StatProps {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  loading: boolean;
}

function Stat({ icon: Icon, label, value, loading }: StatProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5 py-4">
      <span className="flex items-center gap-1.5 text-xs text-app-fg-3">
        <Icon size={13} className="shrink-0 text-app-fg-2" aria-hidden />
        {label}
      </span>
      {loading ? (
        <span className="h-6 w-16 animate-pulse rounded-md bg-app-bg-2" aria-hidden />
      ) : (
        <span className="text-lg font-semibold text-app-fg-4 tabular-nums">{value}</span>
      )}
    </div>
  );
}

/** Period totals: spend, tokens, runs, and average cost per run. */
export function OverviewStrip({ start, end }: { start: string; end: string }) {
  const { data, isLoading, isError } = useUsageSummary({ start, end });

  const cost = data?.costUsd ?? 0;
  const tokens = (data?.inputTokens ?? 0) + (data?.outputTokens ?? 0);
  const runs = data?.runs ?? 0;
  const avg = runs > 0 ? cost / runs : 0;

  if (isError) {
    return (
      <AppCard>
        <p className="text-sm text-app-fg-3">Couldn&apos;t load usage totals. Try again shortly.</p>
      </AppCard>
    );
  }

  return (
    <AppCard padded={false}>
      <div className="grid grid-cols-2 divide-app-bg-2 sm:grid-cols-4 sm:divide-x sm:[&>*]:border-b-0 [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-app-bg-2">
        <Stat icon={Coins} label="Spend" value={formatCost(cost)} loading={isLoading} />
        <Stat icon={Hash} label="Tokens" value={formatTokens(tokens)} loading={isLoading} />
        <Stat icon={Layers} label="Runs" value={runs.toLocaleString()} loading={isLoading} />
        <Stat icon={Repeat} label="Avg / run" value={formatCost(avg)} loading={isLoading} />
      </div>
    </AppCard>
  );
}
