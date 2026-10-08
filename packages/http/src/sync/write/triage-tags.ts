import { emailTriage } from "@alfred/db/schemas";
import type { TriageTagOverrideArgs } from "@alfred/sync";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";

// No Gmail IO here: the label syncs after commit (rfc-triage-tags.md).

/** Set `source='user'`. No-op before the first classification. */
export async function triageTagOverride(
  tx: DbTransaction,
  args: TriageTagOverrideArgs,
  userId: string,
): Promise<{ applied: boolean }> {
  const now = new Date();

  const rows = await tx
    .update(emailTriage)
    .set({
      category: args.category,
      source: "user",
      overriddenAt: now,
      appliedLabelId: null,
      rowVersion: sql`${emailTriage.rowVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, args.threadId)))
    .returning({ sourceThreadId: emailTriage.sourceThreadId });

  return { applied: rows.length > 0 };
}
