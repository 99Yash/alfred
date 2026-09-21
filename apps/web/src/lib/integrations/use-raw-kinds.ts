import { rawReceiptInventorySchema, type InboundEventSource } from "@alfred/contracts";
import { useQuery } from "@tanstack/react-query";
import { client, parseEdenBody } from "~/lib/eden";

/**
 * Raw receipt inventory of one inbound source (ADR-0097 item 9); preserve query
 * state so a failed read stays visible. Shared by the integration detail page
 * and the workflow editor (#990), which lists the kinds as trigger options.
 * `null` disables the query so a caller can keep the hook call unconditional.
 */
export function useRawReceiptKinds(slug: InboundEventSource | null) {
  return useQuery({
    queryKey: ["integrations", "raw-kinds", slug],
    enabled: slug !== null,
    queryFn: async () => {
      if (slug === null) throw new Error("raw receipt inventory needs a source");
      const res = await client.api.integrations["raw-kinds"]({ slug }).get();

      if (res.error) throw new Error(`raw receipt inventory failed (${res.error.status})`);

      return parseEdenBody(rawReceiptInventorySchema, res.data);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
