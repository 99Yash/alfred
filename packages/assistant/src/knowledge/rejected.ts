import { db } from "@alfred/db";
import { rejectedInferences } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
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
