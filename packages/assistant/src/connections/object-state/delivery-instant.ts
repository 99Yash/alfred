import { typedEventReceipts } from "@alfred/db/schemas";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

/**
 * The one reader and writer of a delivery instant at the precision Postgres
 * keeps it (#1200).
 *
 * `event_receipts.delivered_at` is `timestamptz`, which Postgres stores to the
 * microsecond, and `insertReceipt` never sets it — the value is `now()` at
 * insert. `node-postgres` parses that column into a JavaScript `Date`, which
 * holds only milliseconds, so two deliveries 444 µs apart used to compare EQUAL
 * in the object-state recency guard and the later committer won whichever one
 * was actually newer.
 *
 * Every instant on that path therefore travels as ONE exact text form and never
 * as a `Date`:
 *
 *     YYYY-MM-DDTHH:MM:SS.uuuuuuZ
 *
 * Fixed width, zero padded, always six fractional digits, always UTC. Fixed
 * width plus UTC is what makes JavaScript `<` / `>` chronological over these
 * strings, which is the same "a total order or nothing" reason `compareIdentity`
 * and `inKeyLockOrder` in `store.ts` compare with `<`/`>` rather than
 * `localeCompare`.
 *
 * Directory-private except for the three readers `object-state/index.ts`
 * re-exports: the store owns the comparison, and no consumer outside this
 * directory has a reason to build one.
 *
 * None of those three accepts a `Date`. That is the fence, not a convention:
 * `deliveryInstantFromDate(receipt.deliveredAt)` restores the exact truncation
 * #1200 removed and reads correctly, so the only defence that holds is for the
 * name to be unreachable. A caller minting an instant from a clock calls
 * {@link deliveryInstantNow}, which takes no argument. The `Date` mint that
 * fixtures need lives behind
 * `@alfred/assistant/connections/object-state/test-support`, whose subpath no
 * product file has a reason to write.
 */

declare const deliveryInstantBrand: unique symbol;

/**
 * An exact UTC instant at the microsecond resolution Postgres records.
 *
 * Branded because the defect this module closes was a precision loss no
 * signature could see: `deliveredAt: Date` accepted a value that had already
 * thrown its microseconds away, and every call site looked correct. With the
 * brand, {@link deliveryInstantSchema} is the only parser, so a caller cannot
 * invent its own precision.
 */
export type DeliveryInstant = string & { readonly [deliveryInstantBrand]: true };

/**
 * Exactly six fractional digits and a literal `Z`.
 *
 * The comparison in `applyEvent` is lexical, so it is chronological only while
 * every instant is the same width: `"…123Z"` would sort ABOVE `"…099999Z"`.
 * This pattern is the whole defence, which is why it is the only gate and why
 * the store parses both sides of the comparison rather than trusting a select's
 * result type.
 */
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * The only parser. A persisted or selected value enters the type here, never by
 * assertion at a call site.
 */
export const deliveryInstantSchema = z
  .string()
  .regex(MICROSECOND_INSTANT, "expected a UTC instant of the form YYYY-MM-DDTHH:MM:SS.ffffffZ")
  .transform((value) => {
    // SAFETY: `value` matched MICROSECOND_INSTANT, which is exactly the shape
    // the brand names.
    return value as DeliveryInstant;
  });

/**
 * Render a `timestamptz` column in the one text form this module accepts.
 *
 * Postgres formats its own instant, so the read does no arithmetic and loses
 * nothing. `AT TIME ZONE 'UTC'` first, because `to_char` would otherwise render
 * the session's zone and the `Z` suffix would lie.
 */
function instantText(column: SQLWrapper): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * `event_receipts.delivered_at` without the microsecond loss — the select
 * expression every fold caller reads its `deliveredAt` through.
 *
 * The column is `NOT NULL`, so the expression is too.
 */
export function receiptDeliveryInstant(): SQL<DeliveryInstant> {
  return sql<DeliveryInstant>`${instantText(typedEventReceipts.deliveredAt)}`;
}

/**
 * The same read for any nullable `timestamptz` column — the general form.
 *
 * Two readers exist because {@link receiptDeliveryInstant} hard-codes the
 * `typed_event_receipts` view, and four production files select the RAW
 * `event_receipts` table instead. A select whose `from` clause does not hold
 * the view raises Postgres `42P01` on the narrow reader, so it names its own
 * column through this one: `deliveryInstantOf(eventReceipts.deliveredAt)`. The
 * store's locked identity select uses it for `integration_objects`, so the
 * incumbent side of the comparison keeps its microseconds too.
 *
 * The `SQL<…>` result type is an assertion, not a proof. It is honest only
 * because the store parses what comes back with {@link deliveryInstantSchema}
 * before comparing it.
 */
export function deliveryInstantOf(column: SQLWrapper): SQL<DeliveryInstant | null> {
  return sql<DeliveryInstant | null>`${instantText(column)}`;
}

/**
 * Now, from this process's clock, so the instant has only milliseconds.
 *
 * The verified-pull driver (`verified-pull/driver.ts`) mints a receipt that has
 * no row, so its delivery instant is honestly millisecond-true with `000` in
 * the microsecond digits. Anything that
 * HAS a receipt row reads {@link receiptDeliveryInstant} or
 * {@link deliveryInstantOf} instead, and keeps all six.
 *
 * It takes no argument on purpose. A `Date` parameter would accept
 * `receipt.deliveredAt`, which `node-postgres` already truncated — the call
 * would compile, read correctly, and restore the defect #1200 closed. No
 * signature can tell one `Date` from another, so the parameter is removed
 * rather than documented.
 */
export function deliveryInstantNow(): DeliveryInstant {
  // `toISOString` renders exactly three fractional digits; the instant needs
  // six, so the missing microseconds are zero.
  return deliveryInstantSchema.parse(`${new Date().toISOString().slice(0, -1)}000Z`);
}

/**
 * Bind an instant back into a `timestamptz` column with no loss.
 *
 * Postgres parses the text form it produced, so the round trip is exact. A
 * plain `Date` binding here is what truncated the stored value before.
 */
export function deliveryInstantValue(instant: DeliveryInstant): SQL {
  return sql`${instant}::timestamptz`;
}
