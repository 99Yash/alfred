import { IntegrationIcon, type IntegrationBrand } from "~/lib/integration-icons";

export function ProviderTile({
  brand,
  connected,
}: {
  brand: IntegrationBrand;
  connected: boolean;
}) {
  // Full-bleed app-icon tile — the artwork (background + gloss) fills the
  // rounded square, so there's no neutral box for the mark to rattle around in.
  return <IntegrationIcon brand={brand} connected={connected} className="size-9 rounded-xl" />;
}
