import { AlertCircle, RefreshCw } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { useFeatureFlags } from "~/lib/replicache/use-feature-flags";
import { AgentRow } from "./agent-row";
import { BriefingScheduleSection } from "./briefing-schedule-section";
import { BACKGROUND_AGENTS } from "./helpers";

const RETRY_LEADING = <RefreshCw size={13} aria-hidden />;

export function FeaturesSection() {
  const { isOn, setFlag, error, retry } = useFeatureFlags();

  return (
    <>
      <AppCard padded={false}>
        <div className="space-y-1 p-5 pb-2">
          <p className="text-sm font-medium text-app-fg-4">Background agents</p>
          <p className="text-xs text-app-fg-3">
            Enable or disable the agents that run on your behalf.
          </p>
        </div>
        {error ? (
          <div
            className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
            role="alert"
          >
            <div className="flex min-w-0 gap-2.5">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-app-red-4" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-app-fg-4">Agents unavailable</p>
                <p className="mt-1 text-xs leading-5 text-app-fg-3">{error}</p>
              </div>
            </div>
            <AppButton
              size="sm"
              variant="ghost"
              leading={RETRY_LEADING}
              onClick={retry}
              className="shrink-0"
            >
              Retry
            </AppButton>
          </div>
        ) : (
          <div className="divide-y divide-app-bg-2">
            {BACKGROUND_AGENTS.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                checked={agent.prefKey ? isOn(agent.prefKey) : false}
                disabled={agent.comingSoon ?? !agent.prefKey}
                comingSoon={agent.comingSoon}
                onChange={(next) => {
                  // Fire-and-forget optimistic write, matching the sibling
                  // toggle idiom (provider-policy's `void setIntegrationMode`):
                  // Replicache applies the mutation locally and rebases on the
                  // next pull. A load failure surfaces via `error` above.
                  if (agent.prefKey) void setFlag(agent.prefKey, next);
                }}
              />
            ))}
          </div>
        )}
      </AppCard>
      <BriefingScheduleSection />
    </>
  );
}
