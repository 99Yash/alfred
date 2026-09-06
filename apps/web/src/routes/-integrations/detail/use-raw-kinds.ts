import { rawReceiptInventorySchema, type InboundEventSource } from "@alfred/contracts";
import { useQuery } from "@tanstack/react-query";
import { client, parseEdenBody } from "~/lib/eden";

/** Raw receipt inventory; preserve query state so a failed read stays visible. */
export function useRawReceiptKinds(slug: InboundEventSource) {
  return useQuery({
    queryKey: ["integrations", "raw-kinds", slug],
    queryFn: async () => {
      const res = await client.api.integrations["raw-kinds"]({ slug }).get();
      if (res.error) throw new Error(`raw receipt inventory failed (${res.error.status})`);
      return parseEdenBody(rawReceiptInventorySchema, res.data).kinds;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
