import {
  isLiveProviderSlug,
  rawReceiptInventorySchema,
  type RawReceiptKind,
} from "@alfred/contracts";
import { useQuery } from "@tanstack/react-query";
import { client, parseEdenBody } from "~/lib/eden";

/**
 * The raw receipt inventory of one integration (ADR-0097 item 9): each provider
 * kind the event registry does not name, with its count and last-seen time. A
 * planned provider has no credentials and so no receipts; the query is not
 * sent for one. An empty array and a not-yet-loaded read render the same way,
 * as nothing, so the section never flashes.
 */
export function useRawReceiptKinds(slug: string): ReadonlyArray<RawReceiptKind> {
  const live = isLiveProviderSlug(slug);
  const { data } = useQuery<ReadonlyArray<RawReceiptKind>>({
    queryKey: ["integrations", "raw-kinds", slug],
    queryFn: async () => {
      const res = await client.api.integrations["raw-kinds"]({ slug }).get();
      if (res.error) throw new Error(`raw receipt inventory failed (${res.error.status})`);
      return parseEdenBody(rawReceiptInventorySchema, res.data).kinds;
    },
    enabled: live,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  return data ?? [];
}
