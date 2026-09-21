/**
 * The one mint of a {@link DeliveryInstant} from an arbitrary `Date`, kept off
 * the product door (`@alfred/assistant/connections`) because that `Date`
 * parameter IS the defect #1200 closed.
 *
 * `delivery-instant.ts` publishes three readers and none of them takes a
 * `Date`. A `deliveryInstantFromDate` on the product barrel would accept
 * `receipt.deliveredAt` — a value `node-postgres` already truncated to the
 * millisecond — and the call would compile and read correctly while the
 * object-state recency guard returned to last-writer-wins under 1 ms. No
 * signature can tell a clock's `Date` from a column's `Date`, so the name is
 * made unreachable instead of documented.
 *
 * The door is tier 1: an exact `exports` key with no wildcard sibling, so
 * reaching this name from another package means writing a subpath called
 * `test-support`, which no product file has a reason to write.
 * `packages/assistant/src/connections/mcp/test-support.ts` is the precedent.
 *
 * Fixtures need it because a test pins a chosen instant against a window bound,
 * and `deliveryInstantNow()` cannot be chosen. Production never does.
 */

import { deliveryInstantSchema, type DeliveryInstant } from "./delivery-instant";

/**
 * Render a chosen `Date` as an instant whose microsecond digits are `000`.
 *
 * Throws on an invalid `Date`, which cannot render an instant at all.
 * @param at The instant the fixture is pinning.
 */
export function deliveryInstantFromDate(at: Date): DeliveryInstant {
  // `toISOString` renders exactly three fractional digits; the instant needs
  // six, so the missing microseconds are zero.
  return deliveryInstantSchema.parse(`${at.toISOString().slice(0, -1)}000Z`);
}
