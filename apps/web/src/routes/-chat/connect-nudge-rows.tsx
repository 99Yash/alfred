import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ChatConnectNudge } from "@alfred/contracts";
import { ArrowRight } from "lucide-react";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { useResolvedIntegrationsWithReady } from "~/lib/integrations/use-integration-status";
import { cn } from "~/lib/utils";
import { presentConnectNudges } from "./connect-nudges";

/**
 * The in-chat repair offer for a connection-health bounce (#378 item 3): a
 * quiet row under the reply naming what couldn't be used and one action into
 * that provider's connect flow — the same destination the composer's mention
 * palette deep-links to. Renders nothing while credential queries are still
 * loading or when every bounced integration is connected again, so an offer
 * never appears for a problem that no longer exists.
 *
 * Shown live under the streaming bubble (the bounce can land mid-turn) and on
 * reload from the durable tool-call entries.
 */
export function ConnectNudgeRows({ nudges }: { nudges: readonly ChatConnectNudge[] }) {
  const { integrations, ready } = useResolvedIntegrationsWithReady();
  const statusBySlug = useMemo(
    () => (ready ? new Map(integrations.map((p) => [p.slug, p.status])) : undefined),
    [integrations, ready],
  );
  const views = useMemo(() => presentConnectNudges(nudges, statusBySlug), [nudges, statusBySlug]);
  const navigate = useNavigate();
  if (views.length === 0) return null;
  return (
    <>
      {views.map((view) => (
        <div
          key={view.integration}
          className={cn(
            "app-fade-in flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1.5",
            "rounded-xl bg-app-bg-2 px-3 py-2",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <IntegrationGlyph brand={view.brand} size={14} className="shrink-0 opacity-70" />
            <p className="text-[13px] leading-snug text-app-fg-3">{view.line}</p>
          </span>
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/integrations/$slug",
                params: { slug: view.slug },
              })
            }
            className={cn(
              "group/nudge inline-flex items-center gap-1 rounded-md text-[13px] font-medium",
              "text-app-purple-4 outline-none",
              "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
            )}
          >
            {view.cta}
            <ArrowRight
              size={13}
              aria-hidden
              className="transition-transform duration-200 group-hover/nudge:translate-x-0.5 motion-reduce:transition-none"
            />
          </button>
        </div>
      ))}
    </>
  );
}
