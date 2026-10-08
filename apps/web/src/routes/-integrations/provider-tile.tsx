import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";

export function ProviderTile({
  brand,
  connected,
}: {
  brand: IntegrationBrand;
  connected: boolean;
}) {
  // The coin artwork fills the circle; no neutral box.
  return <IntegrationIcon brand={brand} connected={connected} className="size-9 rounded-full" />;
}
