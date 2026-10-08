import { db } from "@alfred/db";
import { rejectedInferences } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { valueSignature } from "./signature";

/** Rejected `(key, value)` patterns that extraction checks before proposing (ADR-0019). */

/** Has the user already rejected `(key, value)`? */
export async function isRejected(userId: string, key: string, value: unknown): Promise<boolean> {
  const sig = valueSignature(value);

  const [hit] = await db()
    .select({ id: rejectedInferences.id })
    .from(rejectedInferences)
    .where(
      and(
        eq(rejectedInferences.userId, userId),
        eq(rejectedInferences.key, key),
        eq(rejectedInferences.valueSignature, sig),
      ),
    )
    .limit(1);

  return hit != null;
}

/** Rejections for `(userId, key?)`, newest first. */
export async function listRejections(
  userId: string,
  key?: string,
  limit = 100,
): Promise<
  Array<{
    id: string;
    key: string;
    valueSignature: string;
    proposedFactId: string | null;
    reason: unknown;
    rejectedAt: Date;
  }>
> {
  const filters = [eq(rejectedInferences.userId, userId)];

  if (key) filters.push(eq(rejectedInferences.key, key));

  const rows = await db()
    .select()
    .from(rejectedInferences)
    .where(and(...filters))
    .orderBy(desc(rejectedInferences.rejectedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    valueSignature: r.valueSignature,
    proposedFactId: r.proposedFactId,
    reason: r.reason,
    rejectedAt: r.rejectedAt,
  }));
}

/** Record a rejection with no `user_facts` row. User rejections go through `rejectFact`. */
export async function recordRejection(args: {
  userId: string;
  key: string;
  value: unknown;
  reason?: unknown;
}): Promise<void> {
  await db()
    .insert(rejectedInferences)
    .values({
      userId: args.userId,
      key: args.key,
      valueSignature: valueSignature(args.value),
      proposedFactId: null,
      reason: args.reason ?? null,
    })
    .onConflictDoNothing();
}
