import type { ActivityObservationSource } from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { z } from "zod";

/**
 * The silent gaps between the stored deliveries of an activity source (ADR-0118 decision 4), and
 * what a provider read proves about one gap. The coverage finds the gaps, and each source's
 * provider read gives the proof.
 */

/** Two arrival times. `from` is `null` when no delivery came before the gap. */
export interface DeliveryGap {
  readonly from: Date | null;
  readonly to: Date;
  /**
   * An act before this time had the grace time to arrive before `to`. A provider read counts only
   * such an act as missed. The grace is off one time: `to` minus the grace when a delivery ends the
   * gap, and the settled end of the read when the read's end closes the gap.
   */
  readonly settledBy: Date;
}

/** What a provider read proves about a delivery gap. `finding` is a clause for the reader. */
export type GapProof =
  /** The read holds acts in the gap whose deliveries did not arrive. */
  | { readonly kind: "missed"; readonly finding: string }
  /** The read is complete, and it holds no act in the gap. */
  | { readonly kind: "none"; readonly finding: string }
  /** The read did not complete, it holds only a part of its acts, or it does not cover the window. */
  | { readonly kind: "unknown" };

const gapRowSchema = z.object({
  from_at: z.coerce.date().nullable(),
  to_at: z.coerce.date(),
});

/**
 * Each silent gap in `[start, until)` between consecutive stored deliveries of `source`, in time
 * order. The last delivery before `start` opens the first gap, and `until` closes the last one.
 * `from` is `null` when no delivery came before the gap: the gap then starts at `start`. A gap is
 * silent when it is longer than `silenceBoundMs`, or when the source never delivered (`from` is
 * `null` and `to` is `until`). A GitHub document is one delivery, and `authored_at` is its arrival
 * time.
 */
export async function silentDeliveryGaps(args: {
  userId: string;
  source: ActivityObservationSource;
  start: Date;
  until: Date;
  silenceBoundMs: number;
}): Promise<Pick<DeliveryGap, "from" | "to">[]> {
  const { userId, source, start, until, silenceBoundMs } = args;

  const result = await db().execute(sql`
    with points as (
      select max(${documents.authoredAt}) as at
        from ${documents}
       where ${documents.userId} = ${userId}
         and ${documents.source} = ${source}
         and ${documents.authoredAt} < ${start}
      union all
      select ${documents.authoredAt}
        from ${documents}
       where ${documents.userId} = ${userId}
         and ${documents.source} = ${source}
         and ${documents.authoredAt} >= ${start}
         and ${documents.authoredAt} < ${until}
      union all
      select ${until}::timestamptz
    ),
    gaps as (
      select lag(at) over (order by at nulls first) as from_at, at as to_at
        from points
    )
    -- The first filter drops the row of the point before the window, and its null when there is none.
    select from_at, to_at
      from gaps
     where to_at >= ${start}
       and (
         to_at - coalesce(from_at, ${start}::timestamptz) > ${`${silenceBoundMs} milliseconds`}::interval
         or (from_at is null and to_at = ${until}::timestamptz)
       )
     order by to_at
  `);

  return rowsFromExecute(result, gapRowSchema).map((row) => ({ from: row.from_at, to: row.to_at }));
}
