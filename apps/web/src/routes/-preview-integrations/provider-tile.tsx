import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";

export function ProviderTile({
  brand,
  connected,
}: {
  brand: IntegrationBrand;
  connected: boolean;
}) {
  // Full-bleed app-icon coin — the artwork (background + gloss) fills the
  // circle, so there's no neutral box for the mark to rattle around in.
  return <IntegrationIcon brand={brand} connected={connected} className="size-9 rounded-full" />;
}
