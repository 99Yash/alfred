import { AppCard } from "~/components/ui/v2";
import { useFeatureFlags } from "~/lib/replicache/use-feature-flags";
import { AgentRow } from "./agent-row";
import { BACKGROUND_AGENTS } from "./helpers";

export function FeaturesSection() {
  const { isOn, setFlag } = useFeatureFlags();

  return (
    <AppCard padded={false}>
      <div className="p-5 pb-2 space-y-1">
        <p className="text-sm font-medium text-app-fg-4">Background agents</p>
        <p className="text-xs text-app-fg-3">
          Enable or disable the agents that run on your behalf.
        </p>
      </div>
      <div className="divide-y divide-app-bg-2">
        {BACKGROUND_AGENTS.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            checked={agent.prefKey ? isOn(agent.prefKey) : false}
            disabled={agent.comingSoon ?? !agent.prefKey}
            comingSoon={agent.comingSoon}
            onChange={(next) => {
              if (agent.prefKey) void setFlag(agent.prefKey, next);
            }}
          />
        ))}
      </div>
    </AppCard>
  );
}
