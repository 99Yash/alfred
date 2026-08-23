import { emailTriage } from "@alfred/db/schemas";
import type { TriageTagOverrideArgs } from "@alfred/sync";
import { and, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";
import type { ServerMutatorCtx } from "./mutator";

// User override of a thread's classifier tag (rfc-triage-tags.md). Writes the
// DB truth inline against the push `tx` (so it commits with the LMID advance);
// the Gmail label is reconciled AFTER commit via `enqueueTriageRelabel`
// (push.ts). No Gmail IO here — external IO cannot be transactional.

/**
 * Override a thread's tag → `source='user'`. No-op if the thread has no
 * `email_triage` row yet (override before first classify); the eventual
 * classify writes `auto` and the user can override again.
 */
export async function triageTagOverride(
  tx: DbTransaction,
  args: TriageTagOverrideArgs,
  ctx: ServerMutatorCtx,
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
    .where(and(eq(emailTriage.userId, ctx.userId), eq(emailTriage.sourceThreadId, args.threadId)))
    .returning({ sourceThreadId: emailTriage.sourceThreadId });
  return { applied: rows.length > 0 };
}
