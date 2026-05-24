import { Link } from "@tanstack/react-router";
import { VsCard } from "~/components/ui/visitors";
import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { ActionPill } from "./action-pill";
import { ProviderTile } from "./provider-tile";

export function ProviderRow({ provider, index }: { provider: IntegrationProvider; index: number }) {
  const isSoon = provider.status === "soon";
  const content = (
    <>
      <ProviderTile brand={provider.brand} connected={provider.status === "connected"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-vs-fg-4">{provider.name}</p>
        <p className="truncate text-xs text-vs-fg-3">{provider.description}</p>
      </div>
      <ActionPill status={provider.status}>{provider.actionLabel}</ActionPill>
    </>
  );

  const cardClassName = cn(
    "vs-card-in flex items-center gap-3 px-3 py-2.5 text-sm",
    isSoon && "opacity-60 cursor-not-allowed",
  );

  if (isSoon) {
    return (
      <VsCard
        padded={false}
        aria-disabled
        className={cardClassName}
        style={{ animationDelay: `${240 + index * 40}ms` }}
      >
        {content}
      </VsCard>
    );
  }

  return (
    <Link
      to="/integrations/$provider"
      params={{ provider: provider.id }}
      className={cn(
        cardClassName,
        "rounded-2xl bg-vs-bg-1 overflow-hidden",
        "shadow-[var(--vs-shadow-elevated)]",
        "transition-shadow vs-press",
        "hover:shadow-[var(--vs-shadow-elevated-hover)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
      style={{ animationDelay: `${240 + index * 40}ms` }}
    >
      {content}
    </Link>
  );
}
