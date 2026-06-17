import type { LoadableIntegrationSlug, PolicyMode } from "@alfred/contracts";
import { AlertCircle, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import type { IntegrationProvider } from "~/lib/integrations";
import { AppButton, AppCard, AppSegmented, type AppSegmentedItem } from "~/components/ui/v2";
import { SectionHeading } from "./section-heading";

const PROVIDER_TO_SLUG: Readonly<Record<string, LoadableIntegrationSlug>> = {
  google_gmail: "gmail",
  google_calendar: "calendar",
  google_drive: "drive",
  google_docs: "docs",
  google_sheets: "sheets",
  google_slides: "slides",
  github: "github",
  slack: "slack",
  linear: "linear",
};

const MODE_ITEMS: ReadonlyArray<AppSegmentedItem<PolicyMode>> = [
  { value: "autonomy", label: "Full autonomy", icon: <Zap size={13} aria-hidden /> },
  { value: "gated", label: "Gated", icon: <ShieldCheck size={13} aria-hidden /> },
];

const RETRY_LEADING = <RefreshCw size={13} aria-hidden />;

export function ProviderPolicy({ provider }: { provider: IntegrationProvider }) {
  const slug = PROVIDER_TO_SLUG[provider.id];
  const { modeFor, setIntegrationMode, loading, error, retry } = useActionPolicy();

  if (!slug) return null;

  // Fall back to the conservative `gated` while the policy row loads so the
  // control never flashes the less-safe option before the real value lands.
  const mode: PolicyMode = modeFor(slug) ?? "gated";

  if (error) {
    return (
      <section className="space-y-3 app-card-in" style={{ animationDelay: "150ms" }}>
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
    <section className="space-y-3 app-card-in" style={{ animationDelay: "150ms" }}>
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
      </AppCard>
    </section>
  );
}
