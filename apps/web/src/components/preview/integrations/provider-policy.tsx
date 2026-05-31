import type { IntegrationSlug, PolicyMode } from "@alfred/contracts";
import { ShieldCheck, Zap } from "lucide-react";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { VsCard, VsSegmented, type VsSegmentedItem } from "~/components/ui/visitors";
import { SectionHeading } from "./section-heading";

/**
 * Catalog provider id → contracts `IntegrationSlug`. Only mapped providers
 * expose a policy control; the policy gates *tools*, which are namespaced by
 * these slugs (ADR-0043 / ADR-0034). Providers absent here (none today) simply
 * don't render the section.
 */
const PROVIDER_TO_SLUG: Readonly<Record<string, IntegrationSlug>> = {
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

const MODE_ITEMS: ReadonlyArray<VsSegmentedItem<PolicyMode>> = [
  { value: "autonomy", label: "Full autonomy", icon: <Zap size={13} /> },
  { value: "gated", label: "Gated", icon: <ShieldCheck size={13} /> },
];

export function ProviderPolicy({ provider }: { provider: IntegrationProvider }) {
  const slug = PROVIDER_TO_SLUG[provider.id];
  const { modeFor, setIntegrationMode, loading } = useActionPolicy();

  if (!slug) return null;

  // Fall back to the conservative `gated` while the policy row loads so the
  // control never flashes the less-safe option before the real value lands.
  const mode: PolicyMode = modeFor(slug) ?? "gated";

  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: "150ms" }}>
      <SectionHeading>Approval policy</SectionHeading>

      <VsCard className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-vs-fg-4">
              {mode === "autonomy" ? "Full autonomy" : "Gated"}
            </p>
            <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">
              {mode === "autonomy"
                ? `Alfred acts on ${provider.name} without pausing for approval.`
                : `Alfred pauses for your approval before any action on ${provider.name}, including reading messages beyond a short preview.`}
            </p>
          </div>
          <VsSegmented<PolicyMode>
            label={`${provider.name} approval policy`}
            value={mode}
            items={MODE_ITEMS}
            onValueChange={(next) => {
              if (loading || next === mode) return;
              void setIntegrationMode(slug, next);
            }}
            className={cn(loading && "opacity-60 pointer-events-none")}
          />
        </div>
      </VsCard>
    </section>
  );
}
