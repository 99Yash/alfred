import { typedEventReceipts } from "@alfred/db/schemas";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

/**
 * Delivery instants at Postgres microsecond precision (#1200). `node-postgres` parses `timestamptz`
 * into a millisecond `Date`, so two deliveries 444 µs apart compared equal. Instants travel as
 * `YYYY-MM-DDTHH:MM:SS.uuuuuuZ`: fixed width and UTC, so `<` is chronological. No exported reader
 * takes a `Date`, because a `Date` has already lost the microseconds. The `Date` mint for fixtures
 * lives in `test-support`.
 */

declare const deliveryInstantBrand: unique symbol;

/**
 * Exact UTC instant at microsecond resolution. Branded so {@link deliveryInstantSchema} is the only
 * way in.
 */
export type DeliveryInstant = string & { readonly [deliveryInstantBrand]: true };

/** Exactly six fractional digits and `Z`. The comparison is lexical, so width must be fixed. */
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The only parser. */
export const deliveryInstantSchema = z
  .string()
  .regex(MICROSECOND_INSTANT, "expected a UTC instant of the form YYYY-MM-DDTHH:MM:SS.ffffffZ")
  .transform((value) => {
    // SAFETY: `value` matched MICROSECOND_INSTANT, the exact shape the brand names.
    return value as DeliveryInstant;
  });

/**
 * Render a `timestamptz` column in this text form. `AT TIME ZONE 'UTC'` first, or the `Z` would
 * lie.
 */
function instantText(column: SQLWrapper): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** `event_receipts.delivered_at` from the `typed_event_receipts` view, with microseconds. */
export function receiptDeliveryInstant(): SQL<DeliveryInstant> {
  return sql<DeliveryInstant>`${instantText(typedEventReceipts.deliveredAt)}`;
}

/**
 * The same read for any `timestamptz` column. Use it for a select that does not read the view, or
 * Postgres raises `42P01`. The result type is unchecked; the store parses it.
 */
export function deliveryInstantOf(column: SQLWrapper): SQL<DeliveryInstant | null> {
  return sql<DeliveryInstant | null>`${instantText(column)}`;
}

/**
 * Now, from the process clock, so the microsecond digits are `000`. For a verified pull, which has
 * no receipt row. No `Date` parameter: it would accept an already truncated value.
 */
export function deliveryInstantNow(): DeliveryInstant {
  // `toISOString` gives three fractional digits; pad to six.
  return deliveryInstantSchema.parse(`${new Date().toISOString().slice(0, -1)}000Z`);
}

/** Bind an instant back into a `timestamptz` column with no loss. */
export function deliveryInstantValue(instant: DeliveryInstant): SQL {
  return sql`${instant}::timestamptz`;
}
