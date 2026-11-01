import { TriangleAlert } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";
import { useConnectionAttention } from "~/lib/integrations/connection-attention";

/**
 * The connections the user must repair, first on the page (ADR-0100 amendment 2026-11-01). The
 * sidebar count leads here. A healthy page shows nothing.
 */
export function NeedsAttention() {
  const items = useConnectionAttention();

  if (items.length === 0) return null;

  return (
    <section className="app-card-in mx-auto mt-10 max-w-2xl space-y-3" aria-label="Needs attention">
      <h2 className="px-1 text-xs font-medium tracking-tight text-app-fg-2 uppercase">
        Needs attention
      </h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.key}>
            <AppCard className="flex items-center gap-3" padded={false}>
              <div className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3">
                <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0 text-app-amber-4" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-app-fg-4">{item.name}</p>
                  {item.detail ? (
                    <p className="mt-0.5 text-[12.5px] leading-5 text-pretty text-app-fg-3">
                      {item.detail}
                    </p>
                  ) : null}
                </div>
              </div>
              <AppButton
                size="sm"
                variant="white"
                className="mr-3.5 shrink-0"
                aria-label={`${item.actionLabel} ${item.name}`}
                onClick={() => {
                  // New tab; the status read refetches on focus, so the item clears on return.
                  openAuthorizationTab(item.url);
                }}
              >
                {item.actionLabel}
              </AppButton>
            </AppCard>
          </li>
        ))}
      </ul>
    </section>
  );
}
