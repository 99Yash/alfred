/**
 * The only `Date` to {@link DeliveryInstant} mint, kept off the product barrel (#1200). A `Date`
 * parameter there would accept `receipt.deliveredAt`, already truncated to the millisecond.
 * Reachable only through the exact `test-support` subpath export.
 */

import { deliveryInstantSchema, type DeliveryInstant } from "./delivery-instant";

/**
 * Render a chosen `Date` with microsecond digits `000`. Throws on an invalid `Date`.
 * @param at The instant the fixture is pinning.
 */
export function deliveryInstantFromDate(at: Date): DeliveryInstant {
  // `toISOString` gives three fractional digits; pad to six.
  return deliveryInstantSchema.parse(`${at.toISOString().slice(0, -1)}000Z`);
}
