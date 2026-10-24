import { isToolName, type PolicyMode, type ToolName } from "@alfred/contracts";
import { AlertCircle, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { toolChipLabel } from "~/components/approvals/card-spec";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import type { IntegrationPage } from "~/lib/integrations/integrations";
import { AppButton, AppCard, AppSegmented, type AppSegmentedItem } from "~/components/ui/v2";
import { SectionHeading } from "./section-heading";

const MODE_ITEMS: ReadonlyArray<AppSegmentedItem<PolicyMode>> = [
  { value: "autonomy", label: "Full autonomy", icon: <Zap size={13} aria-hidden /> },
  { value: "gated", label: "Gated", icon: <ShieldCheck size={13} aria-hidden /> },
];

const RETRY_LEADING = <RefreshCw size={13} aria-hidden />;

export function ProviderPolicy({ provider }: { provider: IntegrationPage }) {
  // Every catalog slug is a loadable provider, so every page has a policy row.
  const { slug } = provider;

  const { policy, modeFor, setIntegrationMode, setToolMode, loading, error, retry } =
    useActionPolicy();

  // `gated` while loading, so the less-safe option never flashes.
  const mode: PolicyMode = modeFor(slug) ?? "gated";

  // Set from an approval card ("Always allow this action"). This list is the only way to undo one.
  const toolOverrides = Object.entries(policy?.integrationRules[slug]?.toolOverrides ?? {}).filter(
    (entry): entry is [ToolName, PolicyMode] => isToolName(entry[0]),
  );

  if (error) {
    return (
      <section className="app-card-in space-y-3" style={{ animationDelay: "150ms" }}>
        <SectionHeading>Approval policy</SectionHeading>
        <AppCard>
          <div
            className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
            role="alert"
          >
            <div className="flex min-w-0 gap-2.5">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-app-red-4" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-app-fg-4">Policy unavailable</p>
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
        </AppCard>
      </section>
    );
  }

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "150ms" }}>
      <SectionHeading>Approval policy</SectionHeading>

      <AppCard className="space-y-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-app-fg-4">
              {mode === "autonomy" ? "Full autonomy" : "Gated"}
            </p>
            <p className="mt-1 text-xs leading-5 text-app-fg-3">
              {mode === "autonomy"
                ? `Alfred acts on ${provider.name} without pausing for approval.`
                : `Alfred pauses for your approval before any action on ${provider.name}, including reading messages beyond a short preview.`}
            </p>
          </div>
          <AppSegmented<PolicyMode>
            label={`${provider.name} approval policy`}
            value={mode}
            items={MODE_ITEMS}
            onValueChange={(next) => {
              if (loading || next === mode) return;
              void setIntegrationMode(slug, next);
            }}
            disabled={loading}
            className={loading ? "opacity-60" : undefined}
          />
        </div>
        {toolOverrides.length > 0 ? (
          <div className="space-y-2 border-t border-app-fg-a1/30 pt-3">
            <p className="text-xs font-medium text-app-fg-3">Action exceptions</p>
            <ul className="space-y-1.5">
              {toolOverrides.map(([toolName, toolMode]) => (
                <li key={toolName} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-app-fg-4">{toolChipLabel(toolName)}</p>
                    <p className="text-xs text-app-fg-3">
                      {toolMode === "autonomy" ? "Always allowed" : "Always asks first"}
                    </p>
                  </div>
                  <AppButton
                    size="sm"
                    variant="ghost"
                    disabled={loading}
                    onClick={() => void setToolMode(toolName, null)}
                    className="shrink-0"
                  >
                    Reset
                  </AppButton>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </AppCard>
    </section>
  );
}
